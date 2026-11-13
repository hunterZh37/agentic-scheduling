import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { account: { findMany: vi.fn() } },
}));
// Never make a real provider call; we only care which accounts get queried.
vi.mock("@/lib/oauth/store", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("./google", () => ({ googleFreeBusy: vi.fn() }));
vi.mock("./microsoft", () => ({ microsoftGetSchedule: vi.fn() }));

import { fanOutBusy } from "./aggregate";
import { prisma } from "@/lib/db";

const START = new Date("2026-08-04T00:00:00Z");
const END = new Date("2026-08-11T00:00:00Z");

beforeEach(() => {
  vi.mocked(prisma.account.findMany).mockReset().mockResolvedValue([] as never);
});

describe("fanOutBusy account scoping", () => {
  // The public booking page resolves the OWNER's free/busy. Owner accounts have
  // coHostId=null; a co-host's connected calendar carries a non-null coHostId
  // and must NEVER subtract from the owner's bookable time. This is the guard
  // that keeps a co-host connecting a calendar from taking the owner's booking
  // page down. See docs/REGRESSIONS.md.
  it("defaults to the owner's accounts only (checkForConflicts + coHostId null)", async () => {
    await fanOutBusy(START, END);
    expect(vi.mocked(prisma.account.findMany)).toHaveBeenCalledWith({
      where: { checkForConflicts: true, coHostId: null },
    });
  });

  it("scopes to a specific co-host when asked (for the future joint engine)", async () => {
    await fanOutBusy(START, END, "clco0host0id");
    expect(vi.mocked(prisma.account.findMany)).toHaveBeenCalledWith({
      where: { checkForConflicts: true, coHostId: "clco0host0id" },
    });
  });
});

describe("fanOutBusy: one slow calendar cannot hold up the booking page", () => {
  // Microsoft Graph took ~21s to answer an Outlook calendar with a 502
  // (2026-11-12), and every free/busy check waited with it. A calendar past the
  // deadline is now a recorded error, and its request is cancelled. Callers
  // already treat an error as "could not check": createBooking refuses to book.
  it("records a hanging account as an error and keeps the others' busy times", async () => {
    vi.useFakeTimers();
    try {
      const { googleFreeBusy } = await import("./google");
      const { microsoftGetSchedule } = await import("./microsoft");
      const { CALENDAR_READ_TIMEOUT_MS } = await import("./deadline");
      vi.mocked(prisma.account.findMany).mockResolvedValue([
        { email: "fast@example.com", provider: "google" },
        { email: "slow@example.com", provider: "microsoft" },
      ] as never);
      const fastBusy = { start: new Date("2026-08-05T17:00:00Z"), end: new Date("2026-08-05T18:00:00Z") };
      vi.mocked(googleFreeBusy).mockResolvedValue([fastBusy] as never);
      let slowSignal: AbortSignal | undefined;
      vi.mocked(microsoftGetSchedule).mockImplementation((_t, _e, _s, _en, signal) => {
        slowSignal = signal;
        return new Promise(() => {});
      });

      const pending = fanOutBusy(START, END);
      await vi.advanceTimersByTimeAsync(CALENDAR_READ_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.busy).toEqual([fastBusy]);
      expect(result.queried).toEqual(["fast@example.com"]);
      expect(result.errors).toEqual([
        { email: "slow@example.com", message: `Didn't answer within ${CALENDAR_READ_TIMEOUT_MS / 1000} seconds.` },
      ]);
      expect(slowSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
