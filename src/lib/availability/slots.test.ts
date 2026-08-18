import { describe, it, expect } from "vitest";
import { computeFreeSlots } from "./slots";
import type { Interval } from "./interval";

const d = (iso: string) => new Date(iso);
const iv = (s: string, e: string): Interval => ({ start: d(s), end: d(e) });
const starts = (list: Interval[]) => list.map((i) => i.start.toISOString());

describe("computeFreeSlots", () => {
  const open = iv("2026-01-01T09:00:00Z", "2026-01-01T11:00:00Z");

  it("slices a clear window into back-to-back duration slots", () => {
    const slots = computeFreeSlots(open, [], {
      durationMinutes: 30,
      bufferMinutes: 0,
      alignMinutes: 0,
    });
    expect(starts(slots)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T09:30:00.000Z",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:30:00.000Z",
    ]);
    expect(slots[0].end.toISOString()).toBe("2026-01-01T09:30:00.000Z");
  });

  it("drops a trailing partial slot that does not fit", () => {
    const slots = computeFreeSlots(iv("2026-01-01T09:00:00Z", "2026-01-01T10:10:00Z"), [], {
      durationMinutes: 30,
      bufferMinutes: 0,
      alignMinutes: 0,
    });
    // 09:00, 09:30, 10:00 would need until 10:30 -> only 09:00 & 09:30 fit.
    expect(starts(slots)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T09:30:00.000Z",
    ]);
  });

  it("keeps buffer clearance around busy intervals", () => {
    // Busy 09:45-10:00 with a 15-min buffer blocks 09:30-10:15.
    const slots = computeFreeSlots(open, [iv("2026-01-01T09:45:00Z", "2026-01-01T10:00:00Z")], {
      durationMinutes: 30,
      bufferMinutes: 15,
      alignMinutes: 0,
    });
    expect(starts(slots)).toEqual([
      "2026-01-01T09:00:00.000Z", // ends 09:30, buffered end 09:30 <= busy-15m start 09:30
      "2026-01-01T10:15:00.000Z", // first start clear of buffered busy (ends 10:15)
    ]);
  });

  it("aligns first slot start up to the clock grid", () => {
    const slots = computeFreeSlots(iv("2026-01-01T09:07:00Z", "2026-01-01T10:00:00Z"), [], {
      durationMinutes: 30,
      bufferMinutes: 0,
      alignMinutes: 15,
    });
    // 09:07 rounds up to 09:15 (ends 09:45); next candidate steps by the 30-min
    // duration to 09:45, which ends 10:15 and no longer fits.
    expect(starts(slots)).toEqual(["2026-01-01T09:15:00.000Z"]);
  });

  it("supports a finer step than the duration", () => {
    const slots = computeFreeSlots(iv("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"), [], {
      durationMinutes: 30,
      bufferMinutes: 0,
      stepMinutes: 15,
      alignMinutes: 0,
    });
    expect(starts(slots)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T09:15:00.000Z",
      "2026-01-01T09:30:00.000Z",
    ]);
  });
});
