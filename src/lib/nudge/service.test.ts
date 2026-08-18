import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { nudge: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() } },
}));
vi.mock("@/lib/clientConfig", () => ({ OWNER_TIMEZONE: "America/Los_Angeles" }));

import { createNudge, listUpcomingNudges, cancelNudge } from "./service";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

const NOW = new Date("2026-07-20T19:00:00Z");

beforeEach(() => {
  vi.mocked(prisma.nudge.create).mockReset().mockResolvedValue({ id: "n1" } as never);
  // No existing duplicate by default.
  vi.mocked(prisma.nudge.findFirst).mockReset().mockResolvedValue(null as never);
  vi.mocked(prisma.nudge.findMany).mockReset();
  vi.mocked(prisma.nudge.delete).mockReset();
});

describe("createNudge", () => {
  it("rejects a fireAt in the past", async () => {
    const r = await createNudge({ fireAtISO: "2026-07-20T18:00:00Z", message: "x" }, NOW);
    expect(r).toEqual({ ok: false, error: "fire_time_in_past" });
    expect(vi.mocked(prisma.nudge.create)).not.toHaveBeenCalled();
  });

  it("rejects an invalid fireAtISO", async () => {
    const r = await createNudge({ fireAtISO: "not-a-date", message: "x" }, NOW);
    expect(r).toEqual({ ok: false, error: "invalid_fire_time" });
  });

  it("creates a nudge with the event link + recurrence", async () => {
    const r = await createNudge(
      {
        fireAtISO: "2026-07-20T19:15:00Z",
        message: "ping",
        recurrenceRule: "FREQ=DAILY",
        event: { kind: "event", id: "e1", account: "hunter@x.com" },
        eventDateISO: "2026-07-20T07:00:00Z",
      },
      NOW
    );
    expect(r.ok).toBe(true);
    const data = vi.mocked(prisma.nudge.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      body: "ping",
      recurrenceRule: "FREQ=DAILY",
      eventKind: "event",
      eventId: "e1",
      eventAccount: "hunter@x.com",
    });
    expect((data.fireAt as Date).toISOString()).toBe("2026-07-20T19:15:00.000Z");
  });

  it("accepts a todo event ref (match-only)", async () => {
    const r = await createNudge(
      { fireAtISO: "2026-07-20T19:15:00Z", message: "call mom", event: { kind: "todo", id: "t1" } },
      NOW
    );
    expect(r.ok).toBe(true);
    const data = vi.mocked(prisma.nudge.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ eventKind: "todo", eventId: "t1" });
  });

  it("reuses an existing reminder at the same minute instead of duplicating", async () => {
    vi.mocked(prisma.nudge.findFirst).mockResolvedValue(
      { id: "existing", fireAt: new Date("2026-07-20T19:15:20Z") } as never
    );
    const r = await createNudge(
      {
        fireAtISO: "2026-07-20T19:15:45Z", // same minute as the existing 19:15:20
        message: "ping",
        event: { kind: "event", id: "e1" },
      },
      NOW
    );
    expect(r).toMatchObject({ ok: true, id: "existing", duplicate: true });
    expect(vi.mocked(prisma.nudge.create)).not.toHaveBeenCalled();
    // Dedup is scoped to the same item + the fire minute window.
    const where = vi.mocked(prisma.nudge.findFirst).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where).toMatchObject({ sentAt: null, failedAt: null, eventKind: "event", eventId: "e1" });
  });
});

describe("listUpcomingNudges", () => {
  it("returns upcoming nudges with a when label + recurring flag", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([
      { id: "a", fireAt: new Date("2026-07-20T19:15:00Z"), body: "ping", recurrenceRule: "FREQ=DAILY", eventKind: "event", eventId: "e1" },
    ] as never);
    const list = await listUpcomingNudges();
    expect(list[0]).toMatchObject({ id: "a", body: "ping", recurring: true, eventKind: "event", eventId: "e1" });
    expect(list[0].whenLabel).toContain("12:15");
  });
});

describe("cancelNudge", () => {
  it("returns ok on delete", async () => {
    vi.mocked(prisma.nudge.delete).mockResolvedValue({} as never);
    expect(await cancelNudge("a")).toEqual({ ok: true });
  });
  it("returns not-ok for an unknown id", async () => {
    vi.mocked(prisma.nudge.delete).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("nope", { code: "P2025", clientVersion: "x" })
    );
    expect(await cancelNudge("gone")).toEqual({ ok: false });
  });
});
