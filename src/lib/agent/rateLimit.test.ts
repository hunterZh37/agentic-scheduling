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

  it("permits exactly one booking per identity, independent of the message window", () => {
    const key = "test:c";
    const t = 3_000_000;
    expect(canBook(key, t)).toBe(true);
    recordBooking(key, t);
    expect(canBook(key, t)).toBe(false);
    // Unlike the message-rate window, the booking guard does not reset once
    // the sliding window rolls over — it's a once-ever-per-identity fence.
    expect(canBook(key, t + 3_600_001)).toBe(false);
  });

  it("tryReserveBooking atomically checks-and-claims: a second concurrent call is rejected", () => {
    const key = "test:d";
    expect(tryReserveBooking(key)).toBe(true);
    expect(tryReserveBooking(key)).toBe(false);
    expect(canBook(key)).toBe(false);
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
