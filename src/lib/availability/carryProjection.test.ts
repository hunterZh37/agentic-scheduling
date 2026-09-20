import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { dayKey } from "@/lib/todos/carryForward";
import { projectCarriedBusy, CARRY_PROJECTION_DAYS, type CarryHead } from "./carryProjection";

// An unfinished timed actionable is carried to the next day at the same
// time-of-day, every day, until it is done. The carried copy only becomes a DB
// row on the day itself (7 AM Pacific cron) — but visitors book days ahead, so
// the slot it WILL occupy was offered as free. See docs/REGRESSIONS.md.

const day = (iso: string) => DateTime.fromISO(iso, { zone: OWNER_TIMEZONE }).startOf("day");
const at = (d: DateTime, h: number, m = 0) => d.set({ hour: h, minute: m }).toUTC().toJSDate();
const head = (d: DateTime, h1: number, h2: number, id = "t1"): CarryHead => ({
  id,
  date: dayKey(d),
  startTime: at(d, h1),
  endTime: at(d, h2),
});

describe("projectCarriedBusy", () => {
  const today = day("2026-09-21");

  it("reserves tomorrow's same time-of-day for today's unfinished actionable", () => {
    const tomorrow = today.plus({ days: 1 });
    const out = projectCarriedBusy([head(today, 15, 16)], at(tomorrow, 0), at(tomorrow, 23));
    expect(out).toEqual([{ start: at(tomorrow, 15), end: at(tomorrow, 16) }]);
  });

  it("covers the overnight gap: yesterday's uncarried actionable reserves today", () => {
    const yesterday = today.minus({ days: 1 });
    const out = projectCarriedBusy([head(yesterday, 10, 11)], at(today, 0), at(today, 23));
    expect(out).toEqual([{ start: at(today, 10), end: at(today, 11) }]);
  });

  it("reserves each day through the projection window, and not the day after it", () => {
    const from = today.plus({ days: 1 });
    const out = projectCarriedBusy(
      [head(today, 15, 16)],
      at(from, 0),
      at(today.plus({ days: CARRY_PROJECTION_DAYS + 3 }), 0)
    );
    expect(out).toHaveLength(CARRY_PROJECTION_DAYS);
    const last = today.plus({ days: CARRY_PROJECTION_DAYS });
    expect(out[out.length - 1]).toEqual({ start: at(last, 15), end: at(last, 16) });
  });

  it("never projects onto the actionable's own day (the real row already covers it)", () => {
    expect(projectCarriedBusy([head(today, 15, 16)], at(today, 0), at(today, 23))).toEqual([]);
  });

  it("only returns projections that overlap the requested window", () => {
    const tomorrow = today.plus({ days: 1 });
    expect(projectCarriedBusy([head(today, 15, 16)], at(tomorrow, 9), at(tomorrow, 10))).toEqual([]);
    // Overlap, not containment.
    expect(
      projectCarriedBusy([head(today, 15, 16)], at(tomorrow, 15, 30), at(tomorrow, 17))
    ).toHaveLength(1);
  });

  it("keeps the local time-of-day and the duration across a DST change", () => {
    // US clocks fall back on 2026-11-01. 3pm must stay 3pm, and stay one hour.
    const sat = day("2026-10-31");
    const sun = sat.plus({ days: 1 });
    const out = projectCarriedBusy([head(sat, 15, 16)], at(sun, 0), at(sun, 23));
    expect(out).toEqual([{ start: at(sun, 15), end: at(sun, 16) }]);
    expect(out[0].end.getTime() - out[0].start.getTime()).toBe(60 * 60 * 1000);
  });

  it("projects several actionables independently", () => {
    const tomorrow = today.plus({ days: 1 });
    const out = projectCarriedBusy(
      [head(today, 9, 10, "a"), head(today, 15, 16, "b")],
      at(tomorrow, 0),
      at(tomorrow, 23)
    );
    expect(out).toHaveLength(2);
  });
});
