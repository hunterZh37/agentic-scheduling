import { describe, it, expect } from "vitest";
import { ruleUntil, withUntil, stripUntil } from "./friendly";
import { expandBlock } from "@/lib/availability/recurrence";

describe("UNTIL round-trip", () => {
  it("adds, reads back, and replaces rather than duplicating", () => {
    const r = withUntil("FREQ=DAILY", new Date("2026-08-26T06:59:59Z"));
    expect(r).toBe("FREQ=DAILY;UNTIL=20260826T065959Z");
    expect(ruleUntil(r)?.toISOString()).toBe("2026-08-26T06:59:59.000Z");
    const again = withUntil(r, new Date("2026-09-01T00:00:00Z"));
    expect(again.match(/UNTIL=/g)).toHaveLength(1);
    expect(stripUntil(again)).toBe("FREQ=DAILY");
  });

  it("leaves a rule without UNTIL alone", () => {
    expect(ruleUntil("FREQ=WEEKLY;BYDAY=MO,WE")).toBeNull();
    expect(stripUntil("FREQ=WEEKLY;BYDAY=MO,WE")).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
  });
});

describe("a repeating block bounded by an end date", () => {
  // The production failure: "7-9am, every day, Aug 5 -> Aug 26" stored as one
  // 21-day span repeating daily covered every minute of every day, so the
  // booking page offered no times at all, on any date, indefinitely.
  const TZ = "America/Los_Angeles";

  it("blocks only its own hours, not the whole day", () => {
    const iv = expandBlock(
      {
        startTime: new Date("2026-08-05T14:00:00Z"), // 7am PT
        endTime: new Date("2026-08-05T16:00:00Z"), // 9am PT
        timezone: TZ,
        recurrenceRule: "FREQ=DAILY;UNTIL=20260827T065959Z",
      },
      new Date("2026-08-10T07:00:00Z"),
      new Date("2026-08-11T07:00:00Z")
    );
    expect(iv).toHaveLength(1);
    expect(iv[0].start.toISOString()).toBe("2026-08-10T14:00:00.000Z");
    expect(iv[0].end.toISOString()).toBe("2026-08-10T16:00:00.000Z");
  });

  it("stops repeating after the end date", () => {
    const iv = expandBlock(
      {
        startTime: new Date("2026-08-05T14:00:00Z"),
        endTime: new Date("2026-08-05T16:00:00Z"),
        timezone: TZ,
        recurrenceRule: "FREQ=DAILY;UNTIL=20260827T065959Z",
      },
      new Date("2026-09-10T07:00:00Z"),
      new Date("2026-09-11T07:00:00Z")
    );
    expect(iv).toHaveLength(0);
  });
});
