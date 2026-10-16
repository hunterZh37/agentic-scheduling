import { formatRange } from "@/lib/timeFormat";
import type { Interval } from "@/lib/availability/interval";

/// A busy interval that can be named back to the owner: a reserved block, an
/// actionable, another booking. Provider free/busy has no name and is passed
/// as plain intervals.
export interface NamedBusy extends Interval {
  /// Shown verbatim after "it overlaps", e.g. `reserved time "Lunch/Dinner"`.
  label: string;
  /// Zone the times are read in; a block's own zone, otherwise the owner's.
  zone: string;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/// Why a slot is rejected as a conflict, in words the owner can act on.
/// "Slot cannot be booked: conflict." sent the owner hunting through a day
/// whose list does not even show reserved blocks (owner, 2026-10-15); the
/// culprit was a weekday Lunch/Dinner block. Names the first overlapping item
/// with its time and counts the rest. Unnamed busy (provider free/busy) is
/// reported as a calendar event.
export function describeConflict(slot: Interval, named: NamedBusy[], unnamed: Interval[]): string {
  const hits = named.filter((n) => overlaps(slot, n));
  const hiddenHits = unnamed.filter((u) => overlaps(slot, u)).length;
  const parts = hits.map((h) => `${h.label} (${formatRange(h.start, h.end, h.zone)})`);
  if (hiddenHits > 0) parts.push(hiddenHits === 1 ? "a calendar event" : `${hiddenHits} calendar events`);
  if (parts.length === 0) return "it overlaps something busy.";
  const [first, ...rest] = parts;
  const tail = rest.length === 0 ? "" : rest.length === 1 ? ` and ${rest[0]}` : ` and ${rest.length} more`;
  return `it overlaps ${first}${tail}.`;
}

/// Unnamed busy minus the intervals that a named item already accounts for:
/// a confirmed booking is also a calendar event in provider free/busy, and a
/// timed actionable is also in the actionable busy set. Matched by exact
/// start and end, which is how the same thing shows up in both lists.
export function withoutNamed(unnamed: Interval[], named: Interval[]): Interval[] {
  const keys = new Set(named.map((n) => `${n.start.getTime()}-${n.end.getTime()}`));
  return unnamed.filter((u) => !keys.has(`${u.start.getTime()}-${u.end.getTime()}`));
}

