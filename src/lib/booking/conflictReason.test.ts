import { describe, it, expect } from "vitest";
import { describeConflict, withoutNamed } from "./conflictReason";

// "Slot cannot be booked: conflict." named nothing, and the day's list does
// not show reserved blocks, so the owner saw a free hour and a refusal
// (owner, 2026-10-15: "there should not be any conflict tho"). The culprit was
// the weekday Lunch/Dinner block, 2:30–3:20 PM Pacific, under a 3–4 PM move.

const PT = "America/Los_Angeles";
const slot = { start: new Date("2026-10-16T22:00:00Z"), end: new Date("2026-10-16T23:00:00Z") }; // 3–4 PM PT
const lunch = {
  label: 'reserved time "Lunch/Dinner"',
  zone: PT,
  start: new Date("2026-10-16T21:30:00Z"),
  end: new Date("2026-10-16T22:20:00Z"),
};
const gym = { label: 'reserved time "GYM"', zone: PT, start: new Date("2026-10-16T19:30:00Z"), end: new Date("2026-10-16T21:30:00Z") };

describe("describeConflict", () => {
  it("names the reserved block and its time, in the block's own zone", () => {
    expect(describeConflict(slot, [lunch, gym], [])).toBe('it overlaps reserved time "Lunch/Dinner" (2:30 – 3:20 PM).');
  });
  it("a touching interval is not a conflict", () => {
    const touching = { ...gym, start: new Date("2026-10-16T21:00:00Z"), end: new Date("2026-10-16T22:00:00Z") };
    expect(describeConflict(slot, [touching], [])).toBe("it overlaps something busy.");
  });
  it("provider busy has no name: a calendar event", () => {
    expect(describeConflict(slot, [], [{ start: new Date("2026-10-16T22:30:00Z"), end: new Date("2026-10-16T23:30:00Z") }])).toBe(
      "it overlaps a calendar event."
    );
  });
  it("two hits: both named; three or more: the first and a count", () => {
    const todo = { label: 'actionable "Implement the second feature"', zone: PT, start: new Date("2026-10-16T22:30:00Z"), end: new Date("2026-10-16T23:00:00Z") };
    expect(describeConflict(slot, [lunch, todo], [])).toBe(
      'it overlaps reserved time "Lunch/Dinner" (2:30 – 3:20 PM) and actionable "Implement the second feature" (3:30 – 4:00 PM).'
    );
    expect(describeConflict(slot, [lunch, todo], [{ start: slot.start, end: slot.end }])).toBe(
      'it overlaps reserved time "Lunch/Dinner" (2:30 – 3:20 PM) and 2 more.'
    );
  });

  it("a booking that is also a calendar event is reported once", () => {
    const bob = { label: 'booking "Call with Bob"', zone: PT, start: new Date("2026-10-16T22:30:00Z"), end: new Date("2026-10-16T23:00:00Z") };
    const providerBusy = [{ start: bob.start, end: bob.end }, { start: new Date("2026-10-16T22:00:00Z"), end: new Date("2026-10-16T22:15:00Z") }];
    expect(describeConflict(slot, [bob], withoutNamed(providerBusy, [bob]))).toBe(
      'it overlaps booking "Call with Bob" (3:30 – 4:00 PM) and a calendar event.'
    );
  });
});

