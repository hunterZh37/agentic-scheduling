import { DateTime } from "luxon";
import { isOvernight } from "@/lib/timeFormat";

/// What the detail panel's "when" row says. Pure, so the one rule that matters
/// is testable: an UNTIMED actionable shows its day and the words "No time
/// set", never a time of day. See docs/REGRESSIONS.md.
export function whenRow(
  item: { start: Date; end: Date; untimed?: boolean },
  zone: string
): { date: string; time: string } {
  const start = DateTime.fromJSDate(item.start, { zone: "utc" }).setZone(zone);
  const date = start.toFormat("cccc, LLLL d");
  if (item.untimed) return { date, time: "No time set" };
  const end = DateTime.fromJSDate(item.end, { zone: "utc" }).setZone(zone);
  const sameMer = start.toFormat("a") === end.toFormat("a");
  const overnight = isOvernight(item.start, item.end, zone);
  // Overnight: the end time alone would read as same-day, so each side
  // carries its weekday, e.g. "11:00 PM Mon – 1:00 AM Tue".
  const range = overnight
    ? `${start.toFormat("h:mm a")} ${start.toFormat("ccc")} – ${end.toFormat("h:mm a")} ${end.toFormat("ccc")}`
    : `${sameMer ? start.toFormat("h:mm") : start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`;
  return { date, time: `${range} · ${zone}` };
}

export type EditedTimes =
  | { kind: "timed"; date: string; start: string; end: string }
  | { kind: "untimed"; date: string }
  | { kind: "error"; message: string };

/// The editor's date and HH:mm fields, resolved to what the save should send.
/// Both times empty = untimed, whether the to-do was untimed already or is
/// being cleared. Both filled = a range; end before start rolls over midnight.
/// `date` is the day key the row must move to (local midnight of the picked
/// day) in both cases, so the caller never recomputes it.
/// One filled = refused: the old add form silently dropped the time in that
/// case, which is how an actionable ends up untimed without anyone meaning it.
export function editedTimes(f: { date: string; start: string; end: string }, zone: string): EditedTimes {
  const hasStart = f.start !== "";
  const hasEnd = f.end !== "";
  const date = DateTime.fromISO(f.date, { zone }).startOf("day").toUTC().toISO()!;
  if (!hasStart && !hasEnd) return { kind: "untimed", date };
  if (hasStart !== hasEnd) {
    return { kind: "error", message: "Set both a start and an end time, or clear both to leave it untimed." };
  }
  const s = DateTime.fromISO(`${f.date}T${f.start}`, { zone });
  let e = DateTime.fromISO(`${f.date}T${f.end}`, { zone });
  if (!s.isValid || !e.isValid) return { kind: "error", message: "That time is not valid." };
  if (e <= s) e = e.plus({ days: 1 });
  return { kind: "timed", date, start: s.toUTC().toISO()!, end: e.toUTC().toISO()! };
}
