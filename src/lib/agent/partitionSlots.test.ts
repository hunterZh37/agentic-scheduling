import { describe, it, expect } from "vitest";
import { partitionSlots } from "./tools";

// The public agent reported "just one opening this Thursday afternoon" while the
// booking page listed eight slots that day — and a re-run of the SAME question
// returned two. The model was choosing its own cut-off for a vague word, so the
// answer varied and everything outside its guess was invisible. The tool now
// searches the whole day and hands back both buckets, which is deterministic.
const slot = (h: number, m = 0) => ({
  start: new Date(Date.UTC(2026, 7, 6, h, m)),
  end: new Date(Date.UTC(2026, 7, 6, h, m + 30)),
});

describe("partitionSlots", () => {
  // 12:00-17:00 PT on Aug 6 == 19:00-00:00 UTC.
  const windowStart = new Date(Date.UTC(2026, 7, 6, 19, 0));
  const windowEnd = new Date(Date.UTC(2026, 7, 7, 0, 0));

  it("keeps slots outside the window instead of dropping them", () => {
    const { matching, alsoFreeSameDay } = partitionSlots(
      [slot(16), slot(23), slot(1 + 24 - 24)], // 9am, 4pm, and one before the window
      windowStart,
      windowEnd
    );
    expect(matching).toHaveLength(1);
    expect(alsoFreeSameDay).toHaveLength(2);
    // Nothing is lost — every slot lands in exactly one bucket.
    expect(matching.length + alsoFreeSameDay.length).toBe(3);
  });

  it("treats the window as start-inclusive, end-exclusive", () => {
    const { matching } = partitionSlots([{ start: windowStart, end: windowEnd }], windowStart, windowEnd);
    expect(matching).toHaveLength(1);
    const atEnd = partitionSlots([{ start: windowEnd, end: windowEnd }], windowStart, windowEnd);
    expect(atEnd.matching).toHaveLength(0);
    expect(atEnd.alsoFreeSameDay).toHaveLength(1);
  });

  it("reports the later slots the assistant was hiding", () => {
    // The real Aug 6 slot list, in UTC (PT + 7).
    const day = [16, 23, 24.5, 25, 27.5, 28, 28.5, 29].map((h) =>
      slot(Math.floor(h) % 24, (h % 1) * 60)
    );
    const { matching, alsoFreeSameDay } = partitionSlots(day, windowStart, windowEnd);
    expect(matching.length).toBeGreaterThan(0);
    // The whole point: the visitor is told about times beyond their phrasing.
    expect(alsoFreeSameDay.length).toBeGreaterThan(0);
  });
});
