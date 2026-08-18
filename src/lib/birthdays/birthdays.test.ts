import { describe, it, expect } from "vitest";
import { parseBirthdayInput, birthdayOccurrencesInRange, sortBirthdaysUpcoming } from "./birthdays";

const TZ = "America/Los_Angeles";

describe("parseBirthdayInput", () => {
  it("accepts a valid entry with year", () => {
    const r = parseBirthdayInput({ name: " Martin ", month: 7, day: 5, year: 1996 });
    expect(r).toEqual({ ok: true, value: { name: "Martin", month: 7, day: 5, year: 1996 } });
  });
  it("accepts a valid entry without year", () => {
    const r = parseBirthdayInput({ name: "Alex", month: 12, day: 31 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.year).toBeUndefined();
  });
  it("accepts Feb 29 (leap-day birthday)", () => {
    expect(parseBirthdayInput({ name: "Leap", month: 2, day: 29 }).ok).toBe(true);
  });
  it("rejects empty name", () => {
    expect(parseBirthdayInput({ name: "  ", month: 1, day: 1 })).toEqual({ ok: false, error: "invalid_name" });
  });
  it("rejects month out of range", () => {
    expect(parseBirthdayInput({ name: "X", month: 13, day: 1 }).ok).toBe(false);
    expect(parseBirthdayInput({ name: "X", month: 0, day: 1 }).ok).toBe(false);
  });
  it("rejects a day past the month's max", () => {
    expect(parseBirthdayInput({ name: "X", month: 2, day: 30 }).ok).toBe(false); // Feb 30
    expect(parseBirthdayInput({ name: "X", month: 4, day: 31 }).ok).toBe(false); // Apr 31
    expect(parseBirthdayInput({ name: "X", month: 1, day: 0 }).ok).toBe(false);
  });
  it("rejects an implausible year", () => {
    expect(parseBirthdayInput({ name: "X", month: 1, day: 1, year: 1800 }).ok).toBe(false);
  });
});

describe("birthdayOccurrencesInRange", () => {
  const martin = { id: "m", name: "Martin", month: 7, day: 5, year: 1996 };
  const noYear = { id: "n", name: "Nadia", month: 7, day: 5, year: null };

  it("includes a birthday whose date falls in the window, with age", () => {
    const start = new Date("2026-07-01T07:00:00Z"); // Jul 1 local PDT
    const end = new Date("2026-08-01T07:00:00Z");
    const occ = birthdayOccurrencesInRange([martin], start, end, TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ id: "m", name: "Martin", age: 30 });
    // date is local midnight Jul 5 in TZ → 07:00Z
    expect(occ[0].date.toISOString()).toBe("2026-07-05T07:00:00.000Z");
  });
  it("age is null without a birth year", () => {
    const start = new Date("2026-07-01T07:00:00Z");
    const end = new Date("2026-08-01T07:00:00Z");
    expect(birthdayOccurrencesInRange([noYear], start, end, TZ)[0].age).toBeNull();
  });
  it("excludes a birthday outside the window", () => {
    const start = new Date("2026-07-06T07:00:00Z");
    const end = new Date("2026-07-10T07:00:00Z");
    expect(birthdayOccurrencesInRange([martin], start, end, TZ)).toHaveLength(0);
  });
  it("falls back a Feb 29 birthday to Feb 28 in a non-leap year", () => {
    const leaper = { id: "l", name: "Leap", month: 2, day: 29, year: null };
    // 2027 is not a leap year → occurrence should land on Feb 28.
    const start = new Date("2027-02-01T08:00:00Z");
    const end = new Date("2027-03-01T08:00:00Z");
    const occ = birthdayOccurrencesInRange([leaper], start, end, TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0].date.toISOString()).toBe("2027-02-28T08:00:00.000Z");
  });
  it("keeps a Feb 29 birthday on Feb 29 in a leap year", () => {
    const leaper = { id: "l", name: "Leap", month: 2, day: 29, year: null };
    const start = new Date("2028-02-01T08:00:00Z"); // 2028 is a leap year
    const end = new Date("2028-03-01T08:00:00Z");
    const occ = birthdayOccurrencesInRange([leaper], start, end, TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0].date.toISOString()).toBe("2028-02-29T08:00:00.000Z");
  });
  it("handles a window spanning a year boundary", () => {
    const nye = { id: "e", name: "Eve", month: 1, day: 1, year: null };
    const start = new Date("2026-12-28T08:00:00Z");
    const end = new Date("2027-01-03T08:00:00Z");
    const occ = birthdayOccurrencesInRange([nye], start, end, TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0].date.toISOString()).toBe("2027-01-01T08:00:00.000Z");
  });
});

describe("sortBirthdaysUpcoming", () => {
  it("orders by next upcoming from today, wrapping the year", () => {
    const today = new Date("2026-12-20T08:00:00Z"); // Dec 20 local
    const list = [
      { id: "a", name: "Jan2", month: 1, day: 2, year: null },
      { id: "b", name: "Dec25", month: 12, day: 25, year: null },
      { id: "c", name: "Jun1", month: 6, day: 1, year: null },
    ];
    expect(sortBirthdaysUpcoming(list, today, TZ).map((b) => b.id)).toEqual(["b", "a", "c"]);
  });
});
