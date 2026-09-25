import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { parseDayParam, dayLinkSearch } from "./dayLink";

// "Here is the link to this specific day you asked to book" (owner,
// 2026-09-24): while a day's times panel is open, the URL carries that day,
// and opening such a link opens the panel. Pure helpers so the rule is tested.

const tz = "America/Los_Angeles";
const today = DateTime.fromISO("2026-09-24", { zone: tz }).startOf("day");

describe("parseDayParam", () => {
  it("accepts a calendar day on or after today in the booker's zone", () => {
    expect(parseDayParam("2026-09-28", tz, today)?.toISODate()).toBe("2026-09-28");
    expect(parseDayParam("2026-09-24", tz, today)?.toISODate()).toBe("2026-09-24");
  });
  it("rejects a past day, garbage, and an absent value", () => {
    expect(parseDayParam("2026-09-23", tz, today)).toBeNull();
    expect(parseDayParam("2026-13-40", tz, today)).toBeNull();
    expect(parseDayParam("tomorrow", tz, today)).toBeNull();
    expect(parseDayParam(undefined, tz, today)).toBeNull();
    expect(parseDayParam("2026-09-28T10:00", tz, today)).toBeNull();
  });
  it("returns the day at local midnight in the booker's zone", () => {
    const d = parseDayParam("2026-09-28", tz, today)!;
    expect(d.zoneName).toBe(tz);
    expect(d.hour).toBe(0);
  });
});

describe("dayLinkSearch", () => {
  const base = new URLSearchParams("preview=1");
  it("adds the open day and keeps unrelated params", () => {
    expect(dayLinkSearch(base, { day: "2026-09-28", duration: 30, defaultDuration: 30 })).toBe("?preview=1&date=2026-09-28");
  });
  it("includes the duration only when it differs from the default", () => {
    expect(dayLinkSearch(base, { day: "2026-09-28", duration: 45, defaultDuration: 30 })).toBe(
      "?preview=1&date=2026-09-28&duration=45"
    );
  });
  it("removes both when no day is open", () => {
    const withDay = new URLSearchParams("preview=1&date=2026-09-28&duration=45");
    expect(dayLinkSearch(withDay, null)).toBe("?preview=1");
    expect(dayLinkSearch(new URLSearchParams("date=2026-09-28"), null)).toBe("");
  });
});
