import { describe, it, expect } from "vitest";
import { endRecurrenceAt, endDateIn, untilStamp } from "./series";

// "Delete all the future events with Olga" (owner, 2026-10-18): two open-ended
// weekly series. Deleting the series would also erase the past lessons; the
// series is ended instead, so the history stays and nothing new appears.

const at = new Date("2026-10-18T22:00:00.000Z");

describe("endRecurrenceAt", () => {
  it("appends UNTIL to the RRULE and keeps EXDATE lines", () => {
    expect(endRecurrenceAt(["RRULE:FREQ=WEEKLY;BYDAY=SU", "EXDATE;TZID=America/Los_Angeles:20260906T080000"], at)).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261018T220000Z",
      "EXDATE;TZID=America/Los_Angeles:20260906T080000",
    ]);
  });
  it("replaces an existing UNTIL or COUNT", () => {
    expect(endRecurrenceAt(["RRULE:FREQ=WEEKLY;UNTIL=20330101T000000Z;BYDAY=FR"], at)).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261018T220000Z"]);
    expect(endRecurrenceAt(["RRULE:FREQ=DAILY;COUNT=400"], at)).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261018T220000Z"]);
  });
  it("a series with no RRULE is untouched", () => {
    expect(endRecurrenceAt(["RDATE:20261101T160000Z"], at)).toEqual(["RDATE:20261101T160000Z"]);
  });
});

describe("stamps", () => {
  it("untilStamp drops punctuation and milliseconds", () => {
    expect(untilStamp(at)).toBe("20261018T220000Z");
  });
  it("endDateIn gives the calendar day in the zone, which can differ from UTC", () => {
    expect(endDateIn(new Date("2026-10-19T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-18");
    expect(endDateIn(new Date("2026-10-19T03:00:00Z"), "UTC")).toBe("2026-10-19");
  });
});
