import { describe, it, expect } from "vitest";
import { availabilityViewIntervalFor } from "./microsoft";

// Microsoft getSchedule errors when the window is shorter than the
// availabilityViewInterval. A booking revalidates against the exact slot, so a
// 30-min meeting must not send a 60-min interval. The interval must always be
// <= the window (and within Microsoft's 5..1440 range).
const mins = (m: number) => new Date(2026, 0, 1, 0, m, 0);

describe("availabilityViewIntervalFor", () => {
  it("never exceeds the window (30-min slot → <= 30)", () => {
    const iv = availabilityViewIntervalFor(mins(0), mins(30));
    expect(iv).toBeLessThanOrEqual(30);
    expect(iv).toBe(30);
  });

  it("fits a 45-min window", () => {
    expect(availabilityViewIntervalFor(mins(0), mins(45))).toBe(45);
  });

  it("caps at 60 for long (day-wide) windows", () => {
    expect(availabilityViewIntervalFor(mins(0), new Date(2026, 0, 2, 0, 0, 0))).toBe(60);
  });

  it("floors at Microsoft's 5-minute minimum for tiny windows", () => {
    expect(availabilityViewIntervalFor(mins(0), mins(1))).toBe(5);
  });

  it("keeps interval <= window across a sweep of realistic slot lengths", () => {
    for (const w of [15, 20, 25, 30, 45, 50, 60, 90, 120]) {
      const iv = availabilityViewIntervalFor(mins(0), mins(w));
      expect(iv).toBeLessThanOrEqual(w);
      expect(iv).toBeGreaterThanOrEqual(5);
    }
  });
});
