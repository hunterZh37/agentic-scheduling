import { describe, it, expect } from "vitest";
import { expandBlock, type RecurringBlock } from "./recurrence";

const d = (iso: string) => new Date(iso);
const starts = (list: { start: Date }[]) => list.map((i) => i.start.toISOString());

// A nightly 23:00–07:00 (8h) sleep block in Los Angeles, anchored well before
// any test range so daily occurrences cover everything.
const sleep: RecurringBlock = {
  startTime: d("2025-01-02T07:00:00Z"), // 2025-01-01 23:00 PST
  endTime: d("2025-01-02T15:00:00Z"),
  timezone: "America/Los_Angeles",
  recurrenceRule: "FREQ=DAILY",
};

describe("expandBlock — recurrence", () => {
  it("preserves local wall-clock across a spring-forward DST change", () => {
    // LA springs forward 2026-03-08 02:00. Nightly 23:00 local should map to
    // 07:00Z before the change and 06:00Z after — same wall time, shifted UTC.
    const intervals = expandBlock(
      sleep,
      d("2026-03-07T00:00:00Z"),
      d("2026-03-10T00:00:00Z")
    );
    expect(starts(intervals)).toEqual([
      "2026-03-07T07:00:00.000Z", // night of Mar 6 (PST)
      "2026-03-08T07:00:00.000Z", // night of Mar 7 (PST)
      "2026-03-09T06:00:00.000Z", // night of Mar 8 (PDT) — UTC shifted by DST
    ]);
  });

  it("catches an overnight occurrence that started the previous day", () => {
    // Range is a morning window; the block that began 23:00 the night before
    // extends into it and must be clamped in.
    const intervals = expandBlock(
      sleep,
      d("2026-01-05T10:00:00Z"),
      d("2026-01-05T12:00:00Z")
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0].start.toISOString()).toBe("2026-01-05T10:00:00.000Z");
    expect(intervals[0].end.toISOString()).toBe("2026-01-05T12:00:00.000Z");
  });

  it("generates occurrences before the stored anchor (anchor is representative, not the pattern start)", () => {
    // A nightly block whose anchor is the night of Jul 11→12. Querying the
    // anchor day itself (Jul 11) must still block that morning's 00:00–07:00,
    // which belongs to the night of Jul 10→11 — an occurrence BEFORE the anchor.
    // rrule won't emit before dtstart, so the expander shifts dtstart back.
    const anchored: RecurringBlock = {
      startTime: d("2026-07-12T06:00:00Z"), // 2026-07-11 23:00 PDT
      endTime: d("2026-07-12T14:00:00Z"), // 2026-07-12 07:00 PDT
      timezone: "America/Los_Angeles",
      recurrenceRule: "FREQ=DAILY",
    };
    const intervals = expandBlock(
      anchored,
      d("2026-07-11T07:00:00Z"), // Jul 11 00:00 PDT
      d("2026-07-12T07:00:00Z") // Jul 12 00:00 PDT
    );
    expect(starts(intervals)).toEqual([
      "2026-07-11T07:00:00.000Z", // 00:00–07:00 PDT — the night before the anchor
      "2026-07-12T06:00:00.000Z", // 23:00–00:00 PDT — the anchor night's start
    ]);
  });

  it("returns a single clamped interval for a one-off block", () => {
    const oneOff: RecurringBlock = {
      startTime: d("2026-02-01T18:00:00Z"),
      endTime: d("2026-02-01T20:00:00Z"),
      timezone: "America/Los_Angeles",
      recurrenceRule: null,
    };
    const intervals = expandBlock(oneOff, d("2026-02-01T00:00:00Z"), d("2026-02-01T19:00:00Z"));
    expect(starts(intervals)).toEqual(["2026-02-01T18:00:00.000Z"]);
    expect(intervals[0].end.toISOString()).toBe("2026-02-01T19:00:00.000Z"); // clamped
  });

  it("returns nothing when a one-off block is outside the range", () => {
    const oneOff: RecurringBlock = {
      startTime: d("2026-02-01T18:00:00Z"),
      endTime: d("2026-02-01T20:00:00Z"),
      timezone: "America/Los_Angeles",
      recurrenceRule: null,
    };
    expect(expandBlock(oneOff, d("2026-03-01T00:00:00Z"), d("2026-03-02T00:00:00Z"))).toEqual([]);
  });
});

describe("blocks longer than their recurrence interval", () => {
  // A multi-day hold that also repeats daily starts a new occurrence while the
  // previous ones are still running. Clamped to a single day they were all the
  // identical interval, so the day's agenda showed one copy per day of the
  // span. Regression: the union is one interval, however long the block is.
  it("collapses overlapping occurrences into a single interval", () => {
    const out = expandBlock(
      {
        startTime: new Date("2026-07-28T07:00:00Z"), // a 9-day span
        endTime: new Date("2026-08-06T07:00:00Z"),
        timezone: "America/Los_Angeles",
        recurrenceRule: "FREQ=DAILY",
      },
      new Date("2026-08-05T07:00:00Z"),
      new Date("2026-08-06T07:00:00Z")
    );
    expect(out).toHaveLength(1);
    expect(out[0].start.toISOString()).toBe("2026-08-05T07:00:00.000Z");
    expect(out[0].end.toISOString()).toBe("2026-08-06T07:00:00.000Z");
  });

  // The merge must not glue genuinely separate occurrences together: a nightly
  // block still yields one interval per night across a multi-day window.
  it("keeps non-overlapping occurrences separate", () => {
    const out = expandBlock(
      {
        startTime: new Date("2026-08-01T06:00:00Z"),
        endTime: new Date("2026-08-01T14:00:00Z"), // 8h nightly
        timezone: "America/Los_Angeles",
        recurrenceRule: "FREQ=DAILY",
      },
      new Date("2026-08-03T00:00:00Z"),
      new Date("2026-08-06T00:00:00Z")
    );
    expect(out.length).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start.getTime()).toBeGreaterThan(out[i - 1].end.getTime());
    }
  });
});
