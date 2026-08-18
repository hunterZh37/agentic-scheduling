import { DateTime } from "luxon";

/// Format a UTC instant as a clock time in a zone, e.g. "9:00 AM" / "2:30 PM".
export function formatTime(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone: "utc" }).setZone(zone).toFormat("h:mm a");
}

/// Compact time without minutes when on the hour, e.g. "9 AM", "1:30 PM".
export function formatTimeCompact(instant: Date, zone: string): string {
  const dt = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(zone);
  return dt.minute === 0 ? dt.toFormat("h a") : dt.toFormat("h:mm a");
}

/// A time range, e.g. "10:30 – 11:30 AM" (drops the meridiem on the start when
/// both share it).
export function formatRange(start: Date, end: Date, zone: string): string {
  const s = DateTime.fromJSDate(start, { zone: "utc" }).setZone(zone);
  const e = DateTime.fromJSDate(end, { zone: "utc" }).setZone(zone);
  const sameMeridiem = s.toFormat("a") === e.toFormat("a");
  const startFmt = sameMeridiem ? s.toFormat("h:mm") : s.toFormat("h:mm a");
  return `${startFmt} – ${e.toFormat("h:mm a")}`;
}

/// "Tuesday · July 14"
export function formatDayHeading(day: DateTime): string {
  return day.toFormat("cccc '·' LLLL d");
}

export function zoneAbbrev(zone: string): string {
  return DateTime.now().setZone(zone).toFormat("ZZZZ");
}

/// "Today 2:30 PM" / "Tomorrow 9:00 AM" / "Mon, Jul 14 2:30 PM", in `zone`.
export function relativeDayTime(instant: Date, zone: string, now?: DateTime): string {
  const dt = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(zone);
  const n = (now ?? DateTime.now()).setZone(zone);
  const label = dt.hasSame(n, "day")
    ? "Today"
    : dt.hasSame(n.plus({ days: 1 }), "day")
      ? "Tomorrow"
      : dt.toFormat("ccc, LLL d");
  return `${label} ${dt.toFormat("h:mm a")}`;
}

/// Overnight = the local end calendar day differs from the local start day.
export function isOvernight(start: Date, end: Date, zone: string): boolean {
  const s = DateTime.fromJSDate(start, { zone: "utc" }).setZone(zone);
  const e = DateTime.fromJSDate(end, { zone: "utc" }).setZone(zone);
  return !e.hasSame(s, "day");
}
