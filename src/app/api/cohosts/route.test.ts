import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: { coHost: { findMany: vi.fn(), create: vi.fn() } },
}));

import { GET, POST } from "./route";
import { prisma } from "@/lib/db";

const postReq = (body: unknown) => ({ json: async () => body }) as NextRequest;

beforeEach(() => {
  vi.mocked(prisma.coHost.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.coHost.create).mockReset();
});

describe("POST /api/cohosts", () => {
  it("creates a co-host, lowercasing the email", async () => {
    vi.mocked(prisma.coHost.create).mockResolvedValue({
      id: "c1",
      email: "ben@brooks.com",
      name: "Ben Brooks",
      timezone: "America/New_York",
    } as never);

    const res = await POST(postReq({ name: "Ben Brooks", email: "Ben@Brooks.com" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ coHost: { id: "c1", email: "ben@brooks.com" } });
    expect(vi.mocked(prisma.coHost.create).mock.calls[0][0]).toMatchObject({
      data: { email: "ben@brooks.com", name: "Ben Brooks" },
    });
  });

  it("passes a valid timezone through and omits it when blank", async () => {
    vi.mocked(prisma.coHost.create).mockResolvedValue({ id: "c1", email: "b@x.com", name: "B", timezone: "Europe/London" } as never);
    await POST(postReq({ name: "B", email: "b@x.com", timezone: "Europe/London" }));
    expect(vi.mocked(prisma.coHost.create).mock.calls[0][0].data).toHaveProperty("timezone", "Europe/London");
  });

  it("rejects a bad email, an empty name, and a garbage timezone", async () => {
    expect((await POST(postReq({ name: "B", email: "nope" }))).status).toBe(400);
    expect((await POST(postReq({ name: "  ", email: "b@x.com" }))).status).toBe(400);
    expect((await POST(postReq({ name: "B", email: "b@x.com", timezone: "Mars/Olympus" }))).status).toBe(400);
    expect(prisma.coHost.create).not.toHaveBeenCalled();
  });

  it("accepts a valid LinkedIn URL and rejects a non-URL", async () => {
    vi.mocked(prisma.coHost.create).mockResolvedValue({
      id: "c1", email: "b@x.com", name: "B", timezone: "America/New_York", linkedin: "https://www.linkedin.com/in/ben",
    } as never);
    const ok = await POST(postReq({ name: "B", email: "b@x.com", linkedin: "https://www.linkedin.com/in/ben" }));
    expect(ok.status).toBe(201);
    expect(vi.mocked(prisma.coHost.create).mock.calls[0][0].data).toMatchObject({
      linkedin: "https://www.linkedin.com/in/ben",
    });
    const bad = await POST(postReq({ name: "B", email: "b@x.com", linkedin: "not a url" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_linkedin" });
  });

  it("409s when the email is already a co-host", async () => {
    vi.mocked(prisma.coHost.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" })
    );
    const res = await POST(postReq({ name: "Ben", email: "ben@brooks.com" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_cohost" });
  });
});

describe("GET /api/cohosts", () => {
  it("lists co-hosts with a connected-calendar count, no calendar addresses", async () => {
    vi.mocked(prisma.coHost.findMany).mockResolvedValue([
      { id: "c1", email: "b@x.com", name: "B", timezone: "America/New_York", linkedin: null, accounts: [{ id: "a1" }] },
      { id: "c2", email: "c@x.com", name: "C", timezone: "America/New_York", linkedin: null, accounts: [] },
    ] as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coHosts).toEqual([
      { id: "c1", email: "b@x.com", name: "B", timezone: "America/New_York", linkedin: null, connectedCalendars: 1 },
      { id: "c2", email: "c@x.com", name: "C", timezone: "America/New_York", linkedin: null, connectedCalendars: 0 },
    ]);
    // Only connected accounts are counted, and no addresses are exposed.
    expect(vi.mocked(prisma.coHost.findMany).mock.calls[0][0]).toMatchObject({
      include: { accounts: { where: { OR: [{ refreshToken: { not: null } }, { accessToken: { not: null } }] } } },
    });
  });
});
