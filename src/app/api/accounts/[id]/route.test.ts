import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    account: { findFirst: vi.fn(), delete: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { DELETE, PATCH } from "./route";
import { prisma } from "@/lib/db";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = {} as NextRequest;
const patchReq = (body: unknown) => ({ json: async () => body }) as NextRequest;

beforeEach(() => {
  vi.mocked(prisma.account.findFirst).mockReset();
  vi.mocked(prisma.account.delete).mockReset();
  vi.mocked(prisma.account.update).mockReset();
  vi.mocked(prisma.account.updateMany).mockReset();
  vi.mocked(prisma.$transaction).mockReset();
});

describe("DELETE /api/accounts/[id]", () => {
  it("deletes a non-destination account", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ id: "a1", isDestination: false } as never);
    vi.mocked(prisma.account.delete).mockResolvedValue({ id: "a1" } as never);
    const res = await DELETE(req, ctx("a1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "a1" });
    expect(prisma.account.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });

  // The lookup is scoped to coHostId:null so a co-host's account (or a bad id)
  // can't be disconnected from the owner routes — the privacy wall.
  it("scopes the lookup to owner accounts (coHostId null)", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ id: "a1", isDestination: false } as never);
    vi.mocked(prisma.account.delete).mockResolvedValue({ id: "a1" } as never);
    await DELETE(req, ctx("a1"));
    expect(prisma.account.findFirst).toHaveBeenCalledWith({ where: { id: "a1", coHostId: null } });
  });

  it("refuses to delete the destination account (409) without deleting", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ id: "d", isDestination: true } as never);
    const res = await DELETE(req, ctx("d"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "is_destination" });
    expect(prisma.account.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when the account doesn't exist (or belongs to a co-host)", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null as never);
    const res = await DELETE(req, ctx("nope"));
    expect(res.status).toBe(404);
    expect(prisma.account.delete).not.toHaveBeenCalled();
  });
});

// Moving where bookings are written — the operation behind "Send bookings here"
// in the Calendars manager. It decides which calendar a stranger's meeting
// lands on, so the failure modes matter more than the happy path.
describe("PATCH /api/accounts/[id] — moving the booking destination", () => {
  it("moves the destination and clears it everywhere else, in one transaction", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({
      id: "work",
      email: "hunter@hunterzhangconsulting.com",
      refreshToken: "tok",
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { count: 1 },
      { id: "work", email: "hunter@hunterzhangconsulting.com", displayName: null, visible: true },
    ] as never);

    const res = await PATCH(patchReq({ isDestination: true }), ctx("work"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { id: "work", email: "hunter@hunterzhangconsulting.com", isDestination: true },
    });
    // Both writes go through ONE $transaction: a partial failure would leave
    // either zero destinations (every booking fails with no_destination) or two
    // (findFirst picks arbitrarily, so bookings land on a coin flip).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$transaction).mock.calls[0][0]).toHaveLength(2);
    // Every OTHER account is cleared, and this one is set — the pair is what
    // keeps "exactly one destination" true.
    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: { isDestination: true, NOT: { id: "work" } },
      data: { isDestination: false },
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "work" },
      data: { isDestination: true },
    });
  });

  it("refuses a calendar with no stored credentials (409)", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({
      id: "fresh",
      email: "hunter@hunterzhangconsulting.com",
      refreshToken: null,
      accessToken: null,
    } as never);

    const res = await PATCH(patchReq({ isDestination: true }), ctx("fresh"));

    // Otherwise the booking page accepts a meeting and the event insert fails
    // afterwards — the visitor has already been told they are booked.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_connected" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to simply clear the destination", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ id: "work" } as never);
    const res = await PATCH(patchReq({ isDestination: false }), ctx("work"));

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("404s for an account that doesn't exist (or belongs to a co-host)", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null as never);

    const res = await PATCH(patchReq({ isDestination: true }), ctx("nope"));

    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
