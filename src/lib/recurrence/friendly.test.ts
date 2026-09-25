import { describe, it, expect } from "vitest";
import { presetToRule, detectPreset, friendlyRecurrence, type RecurrencePreset } from "./friendly";

describe("recurrence presets round-trip", () => {
  const cases: Array<[RecurrencePreset, string, string]> = [
    ["everyday", "FREQ=DAILY", "Every day"],
    ["weekly", "FREQ=WEEKLY", "Weekly"],
    ["weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Weekdays"],
    ["monthly", "FREQ=MONTHLY", "Every month"],
    ["monthlyLast", "FREQ=MONTHLY;BYMONTHDAY=-1", "Every month on the last day"],
  ];
  it.each(cases)("%s -> rule -> label/detect", (preset, rule, label) => {
    expect(presetToRule(preset)).toBe(rule);
    expect(friendlyRecurrence(rule)).toBe(label);
    expect(detectPreset(rule)).toBe(preset);
  });

  it("never has no rule", () => {
    expect(presetToRule("never")).toBeNull();
    expect(friendlyRecurrence(null)).toBe("Once");
    expect(detectPreset(null)).toBe("never");
  });
});

// The owner's Sleep block carried FREQ=DAILY;UNTIL=20260103T075959Z, so it had
// stopped repeating in January, yet the Reserved list still said "Every night"
// and the booking page offered midnight to 7 AM for months (owner,
// 2026-09-24). The label must say when a rule has ended, and say it loudly.
describe("friendlyRecurrence with an end", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const zone = "America/Los_Angeles";
  // The real row: anchor 11 PM Pacific on Jan 1, UNTIL = end of Jan 2 Pacific.
  const anchor = new Date("2026-01-02T07:00:00.000Z");

  it("marks a rule whose UNTIL has passed as ended, on the day the owner picked in the block's zone", () => {
    expect(friendlyRecurrence("FREQ=DAILY;UNTIL=20260103T075959Z", true, { anchor, zone, now })).toBe(
      "Every night · ended Jan 2, 2026"
    );
  });

  it("shows a future UNTIL as 'until'", () => {
    expect(
      friendlyRecurrence("FREQ=WEEKLY;BYDAY=MO,WE,FR,SU;UNTIL=20261231T075959Z", false, { anchor, zone, now })
    ).toBe("Mon · Wed · Fri · Sun · until Dec 30, 2026");
  });

  it("a COUNT that has run out is ended on its last occurrence", () => {
    // 3 nightly occurrences from Jan 1: Jan 1, 2, 3 at 11 PM Pacific.
    expect(friendlyRecurrence("FREQ=DAILY;COUNT=3", true, { anchor, zone, now })).toBe("Every night · ended Jan 3, 2026");
  });

  it("a COUNT still running says until its last occurrence", () => {
    const recent = new Date("2026-09-20T16:00:00.000Z"); // 9 AM Pacific Sep 20
    expect(friendlyRecurrence("FREQ=DAILY;COUNT=10", false, { anchor: recent, zone, now })).toBe("Every day · until Sep 29, 2026");
  });

  it("is unchanged without an end, and without the when argument", () => {
    expect(friendlyRecurrence("FREQ=DAILY", true, { anchor, zone, now })).toBe("Every night");
    expect(friendlyRecurrence("FREQ=DAILY;UNTIL=20260103T075959Z", true)).toBe("Every night");
  });
});

describe("recurrenceEnded", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const zone = "America/Los_Angeles";
  const anchor = new Date("2026-01-02T07:00:00.000Z");
  it("is true only for a rule that has stopped, by UNTIL or by COUNT", async () => {
    const { recurrenceEnded } = await import("./friendly");
    expect(recurrenceEnded("FREQ=DAILY;UNTIL=20260103T075959Z", anchor, zone, now)).toBe(true);
    expect(recurrenceEnded("FREQ=DAILY;COUNT=3", anchor, zone, now)).toBe(true);
    expect(recurrenceEnded("FREQ=DAILY;UNTIL=20261231T075959Z", anchor, zone, now)).toBe(false);
    expect(recurrenceEnded("FREQ=DAILY;COUNT=1000", anchor, zone, now)).toBe(false);
    expect(recurrenceEnded("FREQ=DAILY", anchor, zone, now)).toBe(false);
    expect(recurrenceEnded(null, anchor, zone, now)).toBe(false);
  });
});
