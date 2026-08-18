import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: {
    team: { findMany: vi.fn(), create: vi.fn() },
    coHost: { count: vi.fn() },
  },
}));

import { GET, POST } from "./route";
import { prisma } from "@/lib/db";

const postReq = (body: unknown) => ({ json: async () => body }) as NextRequest;

beforeEach(() => {
  vi.mocked(prisma.team.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.team.create).mockReset();
  vi.mocked(prisma.coHost.count).mockReset().mockResolvedValue(1 as never);
});

const okTeam = {
  id: "t1",
  slug: "hunter-ben",
  name: "Hunter & Ben",
  eventTitle: "Meeting",
  videoLink: null,
  durationOptionsMinutes: [30],
  members: [
    { coHostId: null, coHost: null },
    { coHostId: "ben", coHost: { name: "Ben", email: "ben@x.com" } },
  ],
};

describe("POST /api/teams", () => {
  it("creates a team with the owner plus each co-host as members", async () => {
    vi.mocked(prisma.team.create).mockResolvedValue(okTeam as never);
    const res = await POST(postReq({ name: "Hunter & Ben", slug: "hunter-ben", coHostIds: ["ben"] }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.team).toMatchObject({ slug: "hunter-ben", bookingPath: "/book/hunter-ben" });
    // Owner (coHostId null) is always added alongside the co-hosts.
    const created = vi.mocked(prisma.team.create).mock.calls[0][0].data as {
      members: { create: unknown };
    };
    expect(created.members.create).toEqual([{ coHostId: null }, { coHostId: "ben" }]);
  });

  it("rejects a bad slug, an empty name, and a team with no co-hosts", async () => {
    expect((await POST(postReq({ name: "X", slug: "Bad Slug!", coHostIds: ["ben"] }))).status).toBe(400);
    expect((await POST(postReq({ name: "  ", slug: "ok", coHostIds: ["ben"] }))).status).toBe(400);
    expect((await POST(postReq({ name: "X", slug: "ok", coHostIds: [] }))).status).toBe(400);
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it("refuses a reserved slug", async () => {
    const res = await POST(postReq({ name: "X", slug: "preview", coHostIds: ["ben"] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "reserved_slug" });
  });

  it("refuses a co-host id that does not exist", async () => {
    vi.mocked(prisma.coHost.count).mockResolvedValue(0 as never); // none of the ids found
    const res = await POST(postReq({ name: "X", slug: "ok", coHostIds: ["ghost"] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_cohost" });
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it("409s on a duplicate slug", async () => {
    vi.mocked(prisma.team.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" })
    );
    const res = await POST(postReq({ name: "X", slug: "taken", coHostIds: ["ben"] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug_taken" });
  });

  it("dedupes co-host ids before counting and creating", async () => {
    vi.mocked(prisma.team.create).mockResolvedValue(okTeam as never);
    await POST(postReq({ name: "X", slug: "ok", coHostIds: ["ben", "ben"] }));
    // count() must be asked for the DEDUPED set so it matches, and members too.
    expect(vi.mocked(prisma.coHost.count).mock.calls[0][0]).toMatchObject({
      where: { id: { in: ["ben"] } },
    });
  });
});

describe("GET /api/teams", () => {
  it("serializes teams with owner/cohost member rows and a booking path", async () => {
    vi.mocked(prisma.team.findMany).mockResolvedValue([okTeam] as never);
    const res = await GET();
    const data = await res.json();
    expect(data.teams[0]).toMatchObject({
      slug: "hunter-ben",
      bookingPath: "/book/hunter-ben",
      members: [{ kind: "owner" }, { kind: "cohost", name: "Ben", email: "ben@x.com" }],
    });
  });
});
