import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { birthday: { findMany: vi.fn(), create: vi.fn() } },
}));

import { GET, POST } from "./route";
import { prisma } from "@/lib/db";

function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.mocked(prisma.birthday.findMany).mockReset();
  vi.mocked(prisma.birthday.create).mockReset();
});

describe("GET /api/birthdays", () => {
  it("returns birthdays sorted upcoming-first", async () => {
    vi.mocked(prisma.birthday.findMany).mockResolvedValue([
      { id: "a", name: "Jan2", month: 1, day: 2, year: null },
      { id: "b", name: "Dec25", month: 12, day: 25, year: null },
    ] as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.birthdays.map((b: { id: string }) => b.id)).toHaveLength(2);
  });
});

describe("POST /api/birthdays", () => {
  it("creates a valid birthday (201)", async () => {
    vi.mocked(prisma.birthday.create).mockResolvedValue({ id: "x", name: "Martin", month: 7, day: 5, year: 1996 } as never);
    const res = await POST(jsonReq({ name: "Martin", month: 7, day: 5, year: 1996 }));
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.birthday.create).mock.calls[0][0]).toMatchObject({
      data: { name: "Martin", month: 7, day: 5, year: 1996 },
    });
  });
  it("rejects an invalid date (400) without touching the DB", async () => {
    const res = await POST(jsonReq({ name: "X", month: 2, day: 30 }));
    expect(res.status).toBe(400);
    expect(vi.mocked(prisma.birthday.create)).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON (400)", async () => {
    const bad = { json: async () => { throw new Error("bad"); } } as unknown as NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });
});
