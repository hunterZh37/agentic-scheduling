import { rrulestr } from "rrule";
import { DateTime } from "luxon";
import { Interval, clampInterval, mergeIntervals } from "./interval";

/// The subset of a PersonalBlock the expander needs. Kept structural (not the
/// Prisma type) so the logic stays pure and easy to fixture-test.
export interface RecurringBlock {
  startTime: Date; // UTC anchor
  endTime: Date; // UTC
  timezone: string; // IANA
  recurrenceRule: string | null; // RRULE body, e.g. "FREQ=DAILY"
}

// Convert a real UTC instant to a "floating" Date whose UTC fields equal the
// wall-clock components in `zone`. rrule is timezone-naive and operates on UTC
// fields, so we drive it entirely in this floating space, then reinterpret the
// resulting wall-clock components back into `zone`.
export function toFloating(instant: Date, zone: string): Date {
  const l = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(zone);
  return new Date(Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second));
}

export function floatingToZonedUtc(floating: Date, zone: string): Date {
  // Read the floating Date's UTC fields as wall-clock in `zone`. Luxon resolves
  // DST gaps (spring-forward -> shifts later) and overlaps deterministically.
  return DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
    },
    { zone }
  )
    .toUTC()
    .toJSDate();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/// Expand a PersonalBlock into concrete busy intervals overlapping
/// [rangeStart, rangeEnd). One-off blocks yield at most one interval.
export function expandBlock(
  block: RecurringBlock,
  rangeStart: Date,
  rangeEnd: Date
): Interval[] {
  const durationMs = block.endTime.getTime() - block.startTime.getTime();
  if (durationMs <= 0) return [];

  if (!block.recurrenceRule) {
    const clamped = clampInterval(
      { start: block.startTime, end: block.endTime },
      rangeStart,
      rangeEnd
    );
    return clamped ? [clamped] : [];
  }

  const zone = block.timezone;

  // Widen the query window by a day each side so occurrences that start before
  // rangeStart but extend into it (e.g. an overnight block) are still caught.
  // The look-back must be at least the block's own duration, since a block
  // longer than a day could start well before rangeStart and still overlap it.
  const backoff = Math.max(DAY_MS, durationMs);
  const winStart = toFloating(new Date(rangeStart.getTime() - backoff), zone);
  const winEnd = toFloating(new Date(rangeEnd.getTime() + DAY_MS), zone);

  // rrule never emits occurrences before dtstart, but a recurring block applies
  // to periods before its stored anchor too — the anchor is just a
  // representative occurrence, not the pattern's start of existence. If the
  // look-back window predates the anchor (e.g. querying the anchor day itself,
  // whose overnight portion began the night before), shift dtstart back by whole
  // weeks so those earlier occurrences are generated. Whole-week steps preserve
  // both the wall-clock time and the weekday, keeping any BYDAY/weekly phase
  // intact (occurrences outside [winStart, winEnd] are still filtered out).
  const WEEK_MS = 7 * DAY_MS;
  let dtstart = toFloating(block.startTime, zone);
  if (winStart.getTime() < dtstart.getTime()) {
    const weeksBack = Math.ceil((dtstart.getTime() - winStart.getTime()) / WEEK_MS);
    dtstart = new Date(dtstart.getTime() - weeksBack * WEEK_MS);
  }

  const rule = rrulestr(`RRULE:${block.recurrenceRule}`, { dtstart });

  const out: Interval[] = [];
  for (const occ of rule.between(winStart, winEnd, true)) {
    const startUtc = floatingToZonedUtc(occ, zone);
    // Compute the end in the same floating wall-clock space as the start
    // (rather than startUtc + durationMs) so the end's wall-clock time is
    // preserved across DST transitions instead of drifting by an hour.
    const endUtc = floatingToZonedUtc(new Date(occ.getTime() + durationMs), zone);
    const clamped = clampInterval({ start: startUtc, end: endUtc }, rangeStart, rangeEnd);
    if (clamped) out.push(clamped);
  }
  // Occurrences OVERLAP whenever a block lasts longer than its own recurrence
  // interval — a 9-day span repeating daily starts a new occurrence while the
  // previous eight are still running. Clamped to one day they are all the exact
  // same interval, so the day showed nine identical copies of the block (the
  // count grew with the span). Merging is also correct for the busy-time
  // callers, which only care about the union.
  return mergeIntervals(out);
}

/// Expand many blocks and flatten.
export function expandBlocks(
  blocks: RecurringBlock[],
  rangeStart: Date,
  rangeEnd: Date
): Interval[] {
  return blocks.flatMap((b) => expandBlock(b, rangeStart, rangeEnd));
}
