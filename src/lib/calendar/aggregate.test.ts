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
