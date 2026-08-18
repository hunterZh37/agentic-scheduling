import { describe, it, expect } from "vitest";
import { checkMessageAllowed, canBook, recordBooking, tryReserveBooking, releaseBooking } from "./rateLimit";
import { checkDemoAllowed } from "./rateLimit";

describe("public agent rate limiting", () => {
  it("allows up to 20 messages per window then blocks", () => {
    const key = "test:a";
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(checkMessageAllowed(key, t).ok).toBe(true);
    }
    const blocked = checkMessageAllowed(key, t);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("message_limit");
  });

  it("resets after the window elapses", () => {
    const key = "test:b";
    const t = 2_000_000;
    for (let i = 0; i < 20; i++) checkMessageAllowed(key, t);
    expect(checkMessageAllowed(key, t).ok).toBe(false);
    // One hour + 1ms later
    expect(checkMessageAllowed(key, t + 3_600_001).ok).toBe(true);
  });

  it("permits up to the per-hour booking cap per identity, then resets", () => {
    const key = "test:c";
    const t = 3_000_000;
    // Five bookings in the window are allowed; the sixth is blocked.
    for (let i = 0; i < 5; i++) {
      expect(canBook(key, t)).toBe(true);
      recordBooking(key, t);
    }
    expect(canBook(key, t)).toBe(false);
    // Unlike the old lifetime fence, it RESETS once the 1-hour window rolls over
    // — so a real visitor (or the owner testing) isn't blocked forever.
    expect(canBook(key, t + 3_600_001)).toBe(true);
  });

  it("tryReserveBooking atomically checks-and-claims and caps at the per-window limit", () => {
    const key = "test:d";
    const t = 5_000_000;
    for (let i = 0; i < 5; i++) expect(tryReserveBooking(key, t)).toBe(true);
    expect(tryReserveBooking(key, t)).toBe(false); // cap reached
    expect(canBook(key, t)).toBe(false);
  });

  it("releaseBooking gives the slot back after a failed write", () => {
    const key = "test:e";
    expect(tryReserveBooking(key)).toBe(true);
    releaseBooking(key);
    expect(canBook(key)).toBe(true);
    expect(tryReserveBooking(key)).toBe(true);
  });
});

describe("checkDemoAllowed", () => {
  it("allows up to 5 runs per key then blocks", () => {
    const key = "demo:test-ip-1";
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(checkDemoAllowed(key, t).ok).toBe(true);
    expect(checkDemoAllowed(key, t)).toEqual({ ok: false, reason: "message_limit" });
  });
});
