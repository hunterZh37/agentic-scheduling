import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { shiftToDay } from "@/lib/todos/carryForward";
import type { Interval } from "./interval";

/// How many days ahead an unfinished timed actionable reserves its time-of-day.
///
/// The carry-forward repeats every day until the actionable is done, so the
/// honest answer is "forever" — but one forgotten 30-minute task would then
/// erase that time from the whole booking horizon, which is the same shape as
/// the outage where a reserved block covered all bookable time. A week covers
/// the lead time visitors actually book at, with a bounded blast radius.
export const CARRY_PROJECTION_DAYS = 7;

/// An unfinished, timed actionable that has not been carried forward yet — the
/// live end of a carry chain, i.e. the row the next cron run will copy.
export interface CarryHead {
  id: string;
  /// Todo.date: owner-local midnight of the day it sits on, as a UTC instant.
  date: Date;
  startTime: Date;
  endTime: Date;
}

/// The busy time that carry-forward WILL create, before it exists as rows.
///
/// A head on day H is projected onto H+1 … H+CARRY_PROJECTION_DAYS at the same
/// local time-of-day. Never onto H itself: the real row already counts there.
/// Pure — the caller decides which todos are heads.
export function projectCarriedBusy(heads: CarryHead[], start: Date, end: Date): Interval[] {
  const out: Interval[] = [];
  for (const h of heads) {
    const headDay = DateTime.fromJSDate(h.date, { zone: "utc" }).setZone(OWNER_TIMEZONE).startOf("day");
    // Duration is carried as elapsed time, so an actionable that runs past
    // midnight, or a day with a clock change, keeps its real length.
    const durationMs = h.endTime.getTime() - h.startTime.getTime();
    if (durationMs <= 0) continue;
    for (let k = 1; k <= CARRY_PROJECTION_DAYS; k++) {
      const s = shiftToDay(h.startTime, headDay.plus({ days: k }));
      const e = new Date(s.getTime() + durationMs);
      // Overlap, not containment — same rule as the real rows.
      if (s < end && e > start) out.push({ start: s, end: e });
    }
  }
  return out;
}
