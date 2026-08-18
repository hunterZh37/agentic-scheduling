import { DateTime } from "luxon";
import { getScheduleView, type ScheduleView } from "@/lib/schedule/service";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

/// One item on the day, flattened across the three schedule sources so the
/// brief can present a single chronological picture.
export interface BriefItem {
  title: string;
  start: Date; // UTC
  end: Date; // UTC
  allDay: boolean;
  kind: "event" | "actionable" | "booking" | "birthday";
}

/// Merge a schedule view into one chronological list of the day's items:
/// events, timed actionables, bookings and birthdays. Reserved blocks are
/// excluded — see below.
export function collectBriefItems(view: ScheduleView): BriefItem[] {
  const items: BriefItem[] = [
    ...view.events.map((e) => ({
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      kind: "event" as const,
    })),
    // Reserved blocks are deliberately NOT here. They are the shape of the day,
    // not things that happen in it: a nightly Sleep block appeared twice in one
    // brief (once for the tail of last night, once for tonight) and dominated a
    // three-item summary. Actionables take their place — they were missing
    // entirely, which is why a day full of to-dos could read as nearly empty.
    ...(view.actionables ?? []).map((a) => ({
      title: a.title,
      start: a.start,
      end: a.end,
      allDay: false,
      kind: "actionable" as const,
    })),
    ...view.bookings.map((b) => ({
      title: b.title,
      start: b.start,
      end: b.end,
      allDay: false,
      kind: "booking" as const,
    })),
    ...view.birthdays.map((b) => ({
      title: `🎂 ${b.name}'s birthday${b.age != null ? ` (turns ${b.age})` : ""}`,
      start: b.date,
      end: b.date,
      allDay: true,
      kind: "birthday" as const,
    })),
  ];
  return items.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/// Collapse any run of whitespace (including stray newlines from pasted titles)
/// to single spaces and trim. WhatsApp rejects a template *variable* that
/// contains a newline, a tab, or more than four consecutive spaces, so the
/// whole brief is normalized to a single clean line before it is sent.
function sanitizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/// A short, single-line title for the brief — whitespace-collapsed and clipped
/// so one long event name can't blow out the message.
function clipTitle(title: string, max = 38): string {
  const clean = sanitizeLine(title);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/// The accounts a schedule view failed to load, as a short owner-facing note —
/// or null when every calendar was read cleanly. A view with warnings is NOT an
/// empty day: on 2026-08-15 a transient Outlook fetch failure turned a two-
/// meeting Saturday into "nothing on your calendar. An open day ahead."
function warningNote(view: ScheduleView): string | null {
  const sources = (view.warnings ?? []).map((w) => w.email);
  if (sources.length === 0) return null;
  return `couldn't read ${sources.join(", ")}`;
}

/// Build the concise, WhatsApp-template-safe brief line for `day` (a DateTime
/// anchored in the owner's zone). Pure — the caller supplies the already-fetched
/// schedule so this stays unit-testable without touching the DB or providers.
export function formatMorningBrief(
  view: ScheduleView,
  day: DateTime,
  timezone: string
): string {
  const items = collectBriefItems(view);
  const dateLabel = day.setZone(timezone).toFormat("EEEE, MMM d");
  const fmt = (d: Date) =>
    DateTime.fromJSDate(d, { zone: "utc" }).setZone(timezone).toFormat("h:mm a");
  const note = warningNote(view);

  if (items.length === 0) {
    if (note) {
      return sanitizeLine(
        `${dateLabel} — ${note}, so the day may not be empty. Nothing found on the calendars that did load.`
      );
    }
    return sanitizeLine(`${dateLabel} — nothing on your calendar. An open day ahead.`);
  }

  const timed = items.filter((i) => !i.allDay);
  const allDay = items.filter((i) => i.allDay);

  const n = items.length;
  let line = `${dateLabel} — ${n} ${n === 1 ? "item" : "items"}`;

  // Every timed item, in order. The list used to cap at four with a "+N more"
  // spillover, but the owner wants the full agenda in the message — a "+2
  // more" is exactly the part of the day that gets forgotten. Titles are still
  // clipped so one long name can't blow out the line.
  const shown = timed.map((i) => `${fmt(i.start)} ${clipTitle(i.title)}`);
  const tail: string[] = [];
  if (allDay.length) tail.push(`${allDay.length} all-day`);
  const list = [...shown, ...tail].join(" · ");
  if (list) line += `: ${list}`;

  if (timed.length > 0) {
    const first = timed[0];
    const lastEnd = timed.reduce((a, b) => (b.end.getTime() > a.end.getTime() ? b : a));
    line += `. Starts ${fmt(first.start)}, wraps ${fmt(lastEnd.end)}.`;
  }

  if (note) line += ` Heads up: ${note} — items may be missing.`;

  return sanitizeLine(line);
}

/// Multi-line brief for the freeform WhatsApp path. Unlike a template variable
/// (which forbids newlines), a freeform message can be a real agenda: a header
/// line, then one line per item as "start – end: title". Pure.
export function formatMorningBriefFreeform(
  view: ScheduleView,
  day: DateTime,
  timezone: string
): string {
  const items = collectBriefItems(view);
  const dateLabel = day.setZone(timezone).toFormat("EEEE, MMM d");
  const fmt = (d: Date) =>
    DateTime.fromJSDate(d, { zone: "utc" }).setZone(timezone).toFormat("h:mm a");
  const note = warningNote(view);

  if (items.length === 0) {
    if (note) {
      return `${dateLabel} — ${note}, so the day may not be empty. Nothing found on the calendars that did load.`;
    }
    return `${dateLabel} — nothing on your calendar. An open day ahead.`;
  }

  const n = items.length;
  const header = `${dateLabel} — ${n} ${n === 1 ? "item" : "items"}:`;
  const lines = items.map((i) =>
    i.allDay
      ? `All day: ${clipTitle(i.title, 60)}`
      : `${fmt(i.start)} – ${fmt(i.end)}: ${clipTitle(i.title, 60)}`
  );
  const tail = note ? ["", `Heads up: ${note} — items may be missing.`] : [];
  return [header, "", ...lines, ...tail].join("\n");
}

/// Fetch today's schedule (in the owner's zone) ONCE and render both brief
/// shapes from the same view, so the template line and the email can never
/// disagree. A view with warnings (an account that failed to load) is refetched
/// once after a short delay: provider fetches and token refreshes fail
/// transiently, and a flap at send time otherwise reads as an empty day.
/// Warnings that survive the retry are reported in the brief text and returned
/// so the route can log them.
export async function buildMorningBriefs(
  now: DateTime,
  opts: { retryDelayMs?: number } = {}
): Promise<{ line: string; freeform: string; warnings: ScheduleView["warnings"] }> {
  const retryDelayMs = opts.retryDelayMs ?? 3000;
  const day = now.setZone(OWNER_TIMEZONE).startOf("day");
  const start = day.toUTC().toJSDate();
  const end = day.plus({ days: 1 }).toUTC().toJSDate();

  let view = await getScheduleView(start, end);
  if (view.warnings.length > 0) {
    await new Promise((res) => setTimeout(res, retryDelayMs));
    const retried = await getScheduleView(start, end);
    if (retried.warnings.length < view.warnings.length) view = retried;
  }

  return {
    line: formatMorningBrief(view, day, OWNER_TIMEZONE),
    freeform: formatMorningBriefFreeform(view, day, OWNER_TIMEZONE),
    warnings: view.warnings,
  };
}
