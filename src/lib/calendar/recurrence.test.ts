import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { rruleToGraphRecurrence } from "./recurrence";

const TZ = "America/Los_Angeles";
// Sunday, July 12 2026, 8:00 AM PT — the "w/ Olga CC" case.
const sunday = DateTime.fromISO("2026-07-12T08:00:00", { zone: TZ });

describe("rruleToGraphRecurrence", () => {
  it("weekly with explicit BYDAY", () => {
    const rec = rruleToGraphRecurrence("FREQ=WEEKLY;BYDAY=SU", sunday, TZ);
    expect(rec.pattern).toMatchObject({ type: "weekly", interval: 1, daysOfWeek: ["sunday"] });
    expect(rec.range).toMatchObject({ type: "noEnd", startDate: "2026-07-12", recurrenceTimeZone: TZ });
  });

  it("weekly without BYDAY infers the start's weekday", () => {
    const rec = rruleToGraphRecurrence("FREQ=WEEKLY", sunday, TZ);
    expect(rec.pattern.daysOfWeek).toEqual(["sunday"]);
  });

  it("daily with interval", () => {
    const rec = rruleToGraphRecurrence("FREQ=DAILY;INTERVAL=2", sunday, TZ);
    expect(rec.pattern).toEqual({ type: "daily", interval: 2 });
  });

  it("absolute monthly infers day-of-month from start", () => {
    const rec = rruleToGraphRecurrence("FREQ=MONTHLY", sunday, TZ);
    expect(rec.pattern).toMatchObject({ type: "absoluteMonthly", interval: 1, dayOfMonth: 12 });
  });

  it("relative monthly from an ordinal BYDAY (first Sunday)", () => {
    const rec = rruleToGraphRecurrence("FREQ=MONTHLY;BYDAY=1SU", sunday, TZ);
    expect(rec.pattern).toMatchObject({
      type: "relativeMonthly",
      daysOfWeek: ["sunday"],
      index: "first",
    });
  });

  it("yearly infers month + day from start", () => {
    const rec = rruleToGraphRecurrence("FREQ=YEARLY", sunday, TZ);
    expect(rec.pattern).toMatchObject({ type: "absoluteYearly", month: 7, dayOfMonth: 12 });
  });

  it("COUNT → numbered range", () => {
    const rec = rruleToGraphRecurrence("FREQ=WEEKLY;BYDAY=SU;COUNT=6", sunday, TZ);
    expect(rec.range).toMatchObject({ type: "numbered", numberOfOccurrences: 6 });
  });

  it("UNTIL → endDate range in the recurrence timezone", () => {
    const rec = rruleToGraphRecurrence("FREQ=WEEKLY;BYDAY=SU;UNTIL=20261231T235959Z", sunday, TZ);
    expect(rec.range).toMatchObject({ type: "endDate", endDate: "2026-12-31" });
  });

  it("throws on an unsupported FREQ", () => {
    expect(() => rruleToGraphRecurrence("FREQ=HOURLY", sunday, TZ)).toThrow(/Unsupported/);
  });
});
