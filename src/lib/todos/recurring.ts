import { DateTime } from "luxon";
import { RRule, rrulestr } from "rrule";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { dayKey } from "@/lib/todos/carryForward";

// Recurring actionables. A RecurringTodo is a template ("pay rent, last day of
// every month"); the daily cron materializes each active template's occurrences
// into ordinary Todo rows for the day they fall on. Those carry forward and
// behave like any other actionable, so an unfinished one keeps nagging.
//
// TIMEZONE MODEL. Actionables are day-scoped in the OWNER's timezone. rrule is
// timezone-naive (it treats every instant as floating UTC), so we drive it with
// "naive-UTC" dates: a UTC instant whose Y-M-D equals an owner-local calendar
// day at midnight. Occurrences come back in the same encoding, and we map each
// back to a Todo `date` day-key (owner-local midnight as a UTC instant). This is
// the standard rrule pattern and keeps "last day of the month" correct across
// DST without the hour drift a raw +interval would introduce.

/// The most days back a single run will fill. Bounds catch-up after an outage
/// (or a long-idle template) so we never backfill an entire history at once.
const CATCHUP_DAYS = 40;

/// A UTC instant whose calendar Y-M-D is `day`'s owner-local date at 00:00 — the
/// encoding rrule reasons in. Distinct from a Todo day-key (which is that same
/// local midnight expressed as a real UTC instant); `localDateFromNaive` inverts.
function naiveUtc(day: DateTime): Date {
  const d = day.setZone(OWNER_TIMEZONE);
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day },
    { zone: "utc" }
  ).toJSDate();
}

/// Owner-local calendar day (at midnight) for a naive-UTC occurrence date rrule
/// handed back. Reads the UTC Y-M-D and rebuilds it in the owner's zone.
function localDayFromNaive(occ: Date): DateTime {
  const u = DateTime.fromJSDate(occ, { zone: "utc" });
  return DateTime.fromObject(
    { year: u.year, month: u.month, day: u.day },
    { zone: OWNER_TIMEZONE }
  ).startOf("day");
}

/// Build the rrule for a template, anchored at its creation day so a rule that
/// doesn't name a weekday / day-of-month inherits one, and so occurrences never
/// predate the template. Throws on an unparseable rule.
function ruleFor(rrule: string, anchor: DateTime): RRule {
  const body = rrule.replace(/^RRULE:/i, "").trim();
  // rrulestr wants a full "RRULE:" line; feed it the body plus a DTSTART so the
  // anchor is respected even when the client passed only the RRULE part.
  const opts = RRule.parseString(body);
  opts.dtstart = naiveUtc(anchor);
  return new RRule(opts);
}

/// Validate an RRULE body the way materialization will read it. Returns an error
/// string, or null when it's usable (has a FREQ and parses). Kept pure so the
/// agent tool can reject a bad rule before writing a template.
export function validateRRule(rrule: string): string | null {
  const body = (rrule ?? "").replace(/^RRULE:/i, "").trim();
  if (!body) return "empty rule";
  if (!/(^|;)FREQ=/i.test(body)) return "rule must include a FREQ (e.g. FREQ=MONTHLY)";
  try {
    rrulestr(`RRULE:${body}`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "invalid rule";
  }
}

/// A short human description of an RRULE ("every month on the last day"), for
/// showing a series in the UI. Falls back to the raw rule if rrule can't phrase
/// it. rrule's toText covers the rules this app emits.
export function describeRRule(rrule: string): string {
  const body = (rrule ?? "").replace(/^RRULE:/i, "").trim();
  try {
    const text = new RRule(RRule.parseString(body)).toText();
    return text.charAt(0).toUpperCase() + text.slice(1);
  } catch {
    return body;
  }
}

/// The next owner-local day (at midnight) a rule fires on or after `from`, or
/// null when the rule has no further occurrences (COUNT / UNTIL exhausted).
export function nextOccurrence(
  rrule: string,
  anchor: DateTime,
  from: DateTime = DateTime.now()
): DateTime | null {
  const rule = ruleFor(rrule, anchor.setZone(OWNER_TIMEZONE));
  const occ = rule.after(naiveUtc(from.setZone(OWNER_TIMEZONE).startOf("day")), true);
  return occ ? localDayFromNaive(occ) : null;
}

/// Every owner-local day (inclusive) in [from, through] the rule fires on.
export function occurrencesBetween(
  rrule: string,
  anchor: DateTime,
  from: DateTime,
  through: DateTime
): DateTime[] {
  const rule = ruleFor(rrule, anchor.setZone(OWNER_TIMEZONE));
  const occs = rule.between(
    naiveUtc(from.setZone(OWNER_TIMEZONE).startOf("day")),
    naiveUtc(through.setZone(OWNER_TIMEZONE).startOf("day")),
    true
  );
  return occs.map(localDayFromNaive);
}

interface RecurringTemplate {
  id: string;
  title: string;
  rrule: string;
  startMinutes: number | null;
  endMinutes: number | null;
  location: string | null;
  videoLink: string | null;
  phone: string | null;
  lastMaterializedOn: Date | null;
  createdAt: Date;
}

/// The start/end instants for a timed occurrence on `day`, built in the owner's
/// timezone from minutes-past-local-midnight (DST-safe: it sets the wall clock,
/// not an offset). Null start/end for an untimed template.
function occurrenceTimes(t: RecurringTemplate, day: DateTime): { start: Date | null; end: Date | null } {
  if (t.startMinutes == null || t.endMinutes == null) return { start: null, end: null };
  const base = day.setZone(OWNER_TIMEZONE).startOf("day");
  return {
    start: base.plus({ minutes: t.startMinutes }).toUTC().toJSDate(),
    end: base.plus({ minutes: t.endMinutes }).toUTC().toJSDate(),
  };
}

/// Seed one template's due days in [fromDay, throughDay] as Todo rows. Idempotent:
/// the @@unique([recurringTodoId, date]) constraint rejects a second copy for a
/// day, so overlapping windows / cron retries are safe no-ops. Returns how many
/// new rows were created.
async function seedTemplate(
  t: RecurringTemplate,
  fromDay: DateTime,
  throughDay: DateTime
): Promise<number> {
  const anchor = DateTime.fromJSDate(t.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
  const days = occurrencesBetween(t.rrule, anchor, fromDay, throughDay);
  let created = 0;
  for (const day of days) {
    const date = dayKey(day);
    const { start, end } = occurrenceTimes(t, day);
    // Land at the end of that day's list.
    const last = await prisma.todo.findFirst({
      where: { date },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    try {
      await prisma.todo.create({
        data: {
          title: t.title,
          date,
          startTime: start,
          endTime: end,
          location: t.location,
          videoLink: t.videoLink,
          phone: t.phone,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          recurringTodoId: t.id,
        },
      });
      created++;
    } catch (err) {
      // Already seeded for this day (unique race / re-run) — the outcome we want.
      const code = (err as { code?: string })?.code;
      if (code !== "P2002") throw err;
    }
  }
  return created;
}

/// The [from, through] owner-local day window a run should seed for a template.
/// New template (never materialized): just today, so creating a series never
/// backfills its past. Otherwise from the day after we last ran through, clamped
/// to CATCHUP_DAYS so a long gap fills recent history, not all of it.
function windowFor(t: RecurringTemplate, today: DateTime): { from: DateTime; through: DateTime } {
  const floor = today.minus({ days: CATCHUP_DAYS });
  let from = today;
  if (t.lastMaterializedOn) {
    const last = DateTime.fromJSDate(t.lastMaterializedOn).setZone(OWNER_TIMEZONE).startOf("day");
    from = last.plus({ days: 1 });
  }
  if (from < floor) from = floor;
  return { from, through: today };
}

/// Materialize a SINGLE template up to today and stamp lastMaterializedOn. Used
/// by the create tool so a series whose first occurrence is today shows up
/// immediately, without waiting for the next daily cron.
export async function materializeTemplate(
  t: RecurringTemplate,
  now: DateTime = DateTime.now()
): Promise<number> {
  const today = now.setZone(OWNER_TIMEZONE).startOf("day");
  const { from, through } = windowFor(t, today);
  let created = from <= through ? await seedTemplate(t, from, through) : 0;

  // Eagerly seed the NEXT upcoming occurrence too, even when it's in the future.
  // A recurring to-do should be a real actionable you can SEE on its due day the
  // moment the schedule is created — not a schedule entry that only becomes a
  // to-do the morning it's due. So "pay rent, last day of the month" set up on
  // the 30th puts a real "Pay rent" actionable on the 31st right away (visible
  // with its recurring badge as soon as you look at that day). Bounded to a
  // single occurrence; idempotent via @@unique, so the daily cron reaching that
  // day later is a no-op.
  const anchor = DateTime.fromJSDate(t.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
  const upcoming = nextOccurrence(t.rrule, anchor, today);
  if (upcoming && upcoming > today) {
    created += await seedTemplate(t, upcoming, upcoming);
  }

  await prisma.recurringTodo.update({
    where: { id: t.id },
    data: { lastMaterializedOn: dayKey(today) },
  });
  return created;
}

export interface NewRecurringActionable {
  title: string;
  rrule: string;
  startMinutes?: number | null;
  endMinutes?: number | null;
  location?: string | null;
  videoLink?: string | null;
  phone?: string | null;
}

/// Create a recurring actionable and seed its current + next occurrence, so it's
/// a real to-do on its due day immediately. Shared by the UI's POST /api/recurring
/// and the agent's create_recurring_actionable tool, so both behave identically.
/// Returns an error payload (never throws on validation) instead of a template.
export async function createRecurringActionable(
  input: NewRecurringActionable,
  now: DateTime = DateTime.now()
): Promise<
  | { ok: true; template: { id: string; title: string; rrule: string }; seeded: number; nextOccurrence: string | null }
  | { ok: false; error: string; message: string }
> {
  const title = input.title?.trim();
  if (!title) return { ok: false, error: "missing_title", message: "A title is required." };

  const rrule = (input.rrule ?? "").replace(/^RRULE:/i, "").trim();
  const ruleError = validateRRule(rrule);
  if (ruleError) return { ok: false, error: "invalid_rrule", message: `That schedule is not valid: ${ruleError}.` };

  const hasStart = input.startMinutes != null;
  const hasEnd = input.endMinutes != null;
  if (hasStart !== hasEnd) {
    return { ok: false, error: "invalid_range", message: "Pass both a start and end time, or neither." };
  }
  if (hasStart && hasEnd && input.endMinutes! <= input.startMinutes!) {
    return { ok: false, error: "invalid_range", message: "The end time must be after the start time." };
  }

  const template = await prisma.recurringTodo.create({
    data: {
      title,
      rrule,
      timezone: OWNER_TIMEZONE,
      startMinutes: hasStart ? input.startMinutes! : null,
      endMinutes: hasEnd ? input.endMinutes! : null,
      location: input.location?.trim() || null,
      videoLink: input.videoLink?.trim() || null,
      phone: input.phone?.trim() || null,
    },
  });

  const seeded = await materializeTemplate(template, now);
  const anchor = DateTime.fromJSDate(template.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
  const next = nextOccurrence(rrule, anchor, now);
  return {
    ok: true,
    template: { id: template.id, title: template.title, rrule: template.rrule },
    seeded,
    nextOccurrence: next ? next.toISODate() : null,
  };
}

/// Push a template's CURRENT title/time/where onto every future occurrence it
/// has already seeded (date >= today, not yet done), so editing the schedule's
/// time actually moves the upcoming actionable — including the one already on the
/// calendar. Past and completed occurrences are left as historical record.
export async function resyncFutureOccurrences(
  templateId: string,
  now: DateTime = DateTime.now()
): Promise<number> {
  const t = await prisma.recurringTodo.findUnique({ where: { id: templateId } });
  if (!t) return 0;
  const todayKey = dayKey(now.setZone(OWNER_TIMEZONE).startOf("day"));
  const future = await prisma.todo.findMany({
    where: { recurringTodoId: templateId, done: false, date: { gte: todayKey } },
  });
  let updated = 0;
  for (const todo of future) {
    const day = DateTime.fromJSDate(todo.date).setZone(OWNER_TIMEZONE).startOf("day");
    const start = t.startMinutes != null ? day.plus({ minutes: t.startMinutes }).toUTC().toJSDate() : null;
    const end = t.endMinutes != null ? day.plus({ minutes: t.endMinutes }).toUTC().toJSDate() : null;
    await prisma.todo.update({
      where: { id: todo.id },
      data: { title: t.title, startTime: start, endTime: end, location: t.location, videoLink: t.videoLink, phone: t.phone },
    });
    updated++;
  }
  return updated;
}

/// Edit a recurring schedule in place (title, cadence, time-of-day, where), then
/// resync its future occurrences so the change shows immediately. Only the fields
/// present in `patch` are touched. Returns an error payload on bad input.
export async function updateRecurringActionable(
  id: string,
  patch: Partial<{
    title: string;
    rrule: string;
    startMinutes: number | null;
    endMinutes: number | null;
    location: string | null;
    videoLink: string | null;
    phone: string | null;
  }>,
  now: DateTime = DateTime.now()
): Promise<
  | { ok: true; template: { id: string; title: string; rrule: string }; nextOccurrence: string | null; resynced: number }
  | { ok: false; error: string; message: string }
> {
  const existing = await prisma.recurringTodo.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: "not_found", message: "No recurring actionable with that id." };

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return { ok: false, error: "missing_title", message: "A title is required." };
    data.title = title;
  }
  if (patch.rrule !== undefined) {
    const rrule = patch.rrule.replace(/^RRULE:/i, "").trim();
    const err = validateRRule(rrule);
    if (err) return { ok: false, error: "invalid_rrule", message: `That schedule is not valid: ${err}.` };
    data.rrule = rrule;
  }
  // Time-of-day: both or neither, end after start. A null clears it (untimed).
  if (patch.startMinutes !== undefined || patch.endMinutes !== undefined) {
    const sm = patch.startMinutes ?? null;
    const em = patch.endMinutes ?? null;
    if ((sm == null) !== (em == null)) {
      return { ok: false, error: "invalid_range", message: "Pass both a start and end time, or neither." };
    }
    if (sm != null && em != null && em <= sm) {
      return { ok: false, error: "invalid_range", message: "The end time must be after the start time." };
    }
    data.startMinutes = sm;
    data.endMinutes = em;
  }
  if (patch.location !== undefined) data.location = patch.location?.trim() || null;
  if (patch.videoLink !== undefined) data.videoLink = patch.videoLink?.trim() || null;
  if (patch.phone !== undefined) data.phone = patch.phone?.trim() || null;

  const updated = await prisma.recurringTodo.update({ where: { id }, data });
  const resynced = await resyncFutureOccurrences(id, now);
  const anchor = DateTime.fromJSDate(updated.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
  const next = nextOccurrence(updated.rrule, anchor, now);
  return {
    ok: true,
    template: { id: updated.id, title: updated.title, rrule: updated.rrule },
    nextOccurrence: next ? next.toISODate() : null,
    resynced,
  };
}

/// Materialize every active template up to today. Called by the daily cron.
/// Independent of carry-forward: this seeds today's due recurrences; carry-forward
/// separately rolls yesterday's unfinished actionables (recurring ones included).
export async function materializeRecurringTodos(
  now: DateTime = DateTime.now()
): Promise<{ templates: number; created: number }> {
  const templates = await prisma.recurringTodo.findMany({ where: { active: true } });
  let created = 0;
  for (const t of templates) {
    created += await materializeTemplate(t, now);
  }
  return { templates: templates.length, created };
}
