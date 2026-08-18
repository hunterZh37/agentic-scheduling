import { DateTime } from "luxon";
import type { Interval } from "./interval";

export interface SlotCheckResult {
  /// The input label exactly as given, e.g. "9:30pm".
  slot: string;
  /// UTC ISO start of the slot, or null if the label couldn't be parsed.
  start: string | null;
  /// True when the attendee is free for [start, start + duration).
  free: boolean;
}

/// Parse a Calendly-style local time label ("9:30pm", "9pm", "11:00 PM") on a
/// given ISO date, in a given IANA timezone, to a luxon DateTime. Returns null
/// if the label doesn't look like a wall-clock time. Pure.
export function parseLocalSlot(date: string, label: string, timezone: string): DateTime | null {
  const norm = label.trim().toLowerCase().replace(/\s+/g, "");
  const m = norm.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (hour === 12) hour = 0; // 12am -> 0, 12pm -> 12 (after the +12 below)
  if (m[3] === "pm") hour += 12;
  const dt = DateTime.fromISO(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    { zone: timezone }
  );
  return dt.isValid ? dt : null;
}

/// For each candidate local-time slot, mark it free iff [start, start+duration)
/// overlaps none of the busy intervals (which are UTC). Pure — the caller
/// supplies the busy set (provider free/busy + personal blocks), so this stays
/// deterministic and unit-testable.
export function checkSlots(opts: {
  date: string;
  timezone: string;
  durationMinutes: number;
  slots: string[];
  busy: Interval[];
}): SlotCheckResult[] {
  const durMs = opts.durationMinutes * 60_000;
  return opts.slots.map((label) => {
    const dt = parseLocalSlot(opts.date, label, opts.timezone);
    if (!dt) return { slot: label, start: null, free: false };
    const start = dt.toUTC();
    const startMs = start.toMillis();
    const endMs = startMs + durMs;
    const overlaps = opts.busy.some(
      (b) => startMs < b.end.getTime() && endMs > b.start.getTime()
    );
    return { slot: label, start: start.toISO(), free: !overlaps };
  });
}
