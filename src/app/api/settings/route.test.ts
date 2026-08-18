import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { settings: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import { GET, PATCH } from "./route";
import { prisma } from "@/lib/db";

const patchReq = (body: unknown) => ({ json: async () => body }) as NextRequest;

beforeEach(() => {
  vi.mocked(prisma.settings.findUnique).mockReset();
  vi.mocked(prisma.settings.upsert).mockReset();
});

describe("GET /api/settings", () => {
  it("returns defaults (minNotice 0) when no row exists", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null as never);
    const res = await GET();
    expect(await res.json()).toEqual({
      settings: { bookingHorizonDays: 60, minNoticeHours: 0, bufferMinutes: 0, defaultEventDurationMinutes: 30 },
    });
  });

  it("returns the stored row's values", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({
      bookingHorizonDays: 30, minNoticeHours: 4, bufferMinutes: 15, defaultEventDurationMinutes: 45,
    } as never);
    const res = await GET();
    expect((await res.json()).settings).toMatchObject({ minNoticeHours: 4, bufferMinutes: 15 });
  });
});

describe("PATCH /api/settings", () => {
  it("accepts minNoticeHours: 0 (removing the notice) and upserts it", async () => {
    vi.mocked(prisma.settings.upsert).mockResolvedValue({
      bookingHorizonDays: 60, minNoticeHours: 0, bufferMinutes: 0, defaultEventDurationMinutes: 30,
    } as never);
    const res = await PATCH(patchReq({ minNoticeHours: 0 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.settings.upsert).mock.calls[0][0].update).toEqual({ minNoticeHours: 0 });
  });

  it("rejects out-of-range and non-integer values", async () => {
    expect((await PATCH(patchReq({ minNoticeHours: -1 }))).status).toBe(400);
    expect((await PATCH(patchReq({ bookingHorizonDays: 0 }))).status).toBe(400); // must be >= 1
    expect((await PATCH(patchReq({ defaultEventDurationMinutes: 2 }))).status).toBe(400); // < 5
    expect((await PATCH(patchReq({ bufferMinutes: 3.5 }))).status).toBe(400); // non-integer
    expect(prisma.settings.upsert).not.toHaveBeenCalled();
  });

  it("400s when no known field is sent", async () => {
    const res = await PATCH(patchReq({ nonsense: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_fields" });
  });
});
