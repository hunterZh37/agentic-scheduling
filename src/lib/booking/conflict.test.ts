import { describe, it, expect } from "vitest";
import { checkSlotBookable } from "./conflict";
import type { AvailabilitySettings } from "@/lib/availability/index";
import type { Interval } from "@/lib/availability/interval";

const d = (iso: string) => new Date(iso);
const iv = (s: string, e: string): Interval => ({ start: d(s), end: d(e) });

const SETTINGS: AvailabilitySettings = {
  bookingHorizonDays: 60,
  minNoticeHours: 2,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
};
const now = d("2026-06-01T12:00:00Z");

describe("checkSlotBookable", () => {
  it("accepts a clear future slot within notice + horizon", () => {
    expect(checkSlotBookable(iv("2026-06-03T15:00:00Z", "2026-06-03T15:30:00Z"), [], now, SETTINGS)).toBeNull();
  });

  it("rejects a slot in the past", () => {
    expect(checkSlotBookable(iv("2026-05-30T15:00:00Z", "2026-05-30T15:30:00Z"), [], now, SETTINGS)).toBe("in_past");
  });

  it("rejects a slot inside the min-notice window", () => {
    // 1h out, but min notice is 2h.
    expect(checkSlotBookable(iv("2026-06-01T13:00:00Z", "2026-06-01T13:30:00Z"), [], now, SETTINGS)).toBe("too_soon");
  });

  it("rejects a slot beyond the booking horizon", () => {
    expect(checkSlotBookable(iv("2026-09-01T15:00:00Z", "2026-09-01T15:30:00Z"), [], now, SETTINGS)).toBe("beyond_horizon");
  });

  it("rejects a slot overlapping a busy interval", () => {
    const busy = [iv("2026-06-03T15:15:00Z", "2026-06-03T15:45:00Z")];
    expect(checkSlotBookable(iv("2026-06-03T15:00:00Z", "2026-06-03T15:30:00Z"), busy, now, SETTINGS)).toBe("conflict");
  });

  it("accepts a slot that merely touches a busy interval edge", () => {
    const busy = [iv("2026-06-03T15:30:00Z", "2026-06-03T16:00:00Z")];
    expect(checkSlotBookable(iv("2026-06-03T15:00:00Z", "2026-06-03T15:30:00Z"), busy, now, SETTINGS)).toBeNull();
  });

  // Security-audit finding (2026-08-18): nothing bounded end - start, so one
  // anonymous POST could book a weeks-long "meeting" that becomes a busy
  // interval blocking ALL future availability — the attacker-triggered twin of
  // the reserved-block outage in docs/REGRESSIONS.md. The cap lives in
  // checkSlotBookable so every write path (public route, public agent, MCP,
  // reschedule) inherits it; these pin that.
  it("rejects a slot longer than 24 hours as too_long", () => {
    expect(checkSlotBookable(iv("2026-06-03T15:00:00Z", "2026-06-05T15:00:00Z"), [], now, SETTINGS)).toBe("too_long");
  });

  it("rejects a horizon-length slot as too_long even when otherwise clear", () => {
    expect(checkSlotBookable(iv("2026-06-02T12:00:00Z", "2026-07-25T12:00:00Z"), [], now, SETTINGS)).toBe("too_long");
  });

  it("still accepts a slot of exactly 24 hours", () => {
    expect(checkSlotBookable(iv("2026-06-03T12:00:00Z", "2026-06-04T12:00:00Z"), [], now, SETTINGS)).toBeNull();
  });
});
