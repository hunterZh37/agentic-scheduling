import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { nudge: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/schedule/service", () => ({ getScheduleView: vi.fn() }));
vi.mock("@/lib/booking/service", () => ({ alertHost: vi.fn() }));

import { processDueNudges } from "./worker";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-07-20T19:15:00Z");
const base = {
  id: "n1", body: "ping", timezone: "America/Los_Angeles", recurrenceRule: null,
  eventKind: null, eventId: null, eventAccount: null, eventDate: null,
  fireAt: new Date("2026-07-20T19:15:00Z"), attempts: 0,
};

beforeEach(() => {
  vi.mocked(prisma.nudge.findMany).mockReset();
  vi.mocked(prisma.nudge.updateMany).mockReset().mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.nudge.update).mockReset().mockResolvedValue({} as never);
});

describe("processDueNudges", () => {
  it("sends a due one-off and leaves it sent (no re-arm)", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base }] as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const resolveEvent = vi.fn().mockResolvedValue(null);
    const res = await processDueNudges({ now: NOW, send, resolveEvent });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("ping", "ping"); // snapshot body (event unresolved)
    expect(res.sent).toBe(1);
    expect(res.rearmed).toBe(0);
    // claim set sentAt; no re-arm update that clears it
    expect(vi.mocked(prisma.nudge.update)).not.toHaveBeenCalled();
  });

  it("re-arms a recurring nudge to the next occurrence", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base, recurrenceRule: "FREQ=DAILY" }] as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processDueNudges({ now: NOW, send, resolveEvent: () => Promise.resolve(null) });
    expect(res.rearmed).toBe(1);
    const upd = vi.mocked(prisma.nudge.update).mock.calls[0][0] as { data: { fireAt: Date; sentAt: null; attempts: number } };
    expect(upd.data.sentAt).toBeNull();
    expect(upd.data.attempts).toBe(0);
    expect(upd.data.fireAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("uses the resolved event's fresh details when available", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base, eventKind: "event", eventId: "e1" }] as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const resolveEvent = vi.fn().mockResolvedValue({ title: "Schedule Planning", start: new Date("2026-07-20T19:30:00Z") });
    await processDueNudges({ now: NOW, send, resolveEvent });
    expect(send.mock.calls[0][0]).toContain("Schedule Planning");
  });

  it("dead-letters after MAX_ATTEMPTS on send failure", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base, attempts: 4 }] as never);
    const send = vi.fn().mockRejectedValue(new Error("twilio down"));
    const res = await processDueNudges({ now: NOW, send, resolveEvent: () => Promise.resolve(null) });
    expect(res.deadLettered).toBe(1);
    const upd = vi.mocked(prisma.nudge.update).mock.calls[0][0] as { data: { failedAt: Date } };
    expect(upd.data.failedAt).toEqual(NOW);
  });

  it("releases the claim for retry on a transient failure below the cap", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base, attempts: 0 }] as never);
    const send = vi.fn().mockRejectedValue(new Error("blip"));
    const res = await processDueNudges({ now: NOW, send, resolveEvent: () => Promise.resolve(null) });
    expect(res.deadLettered).toBe(0);
    const upd = vi.mocked(prisma.nudge.update).mock.calls[0][0] as { data: { sentAt: null } };
    expect(upd.data.sentAt).toBeNull();
  });

  it("skips a nudge another run already claimed (claim count 0)", async () => {
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base }] as never);
    vi.mocked(prisma.nudge.updateMany).mockResolvedValue({ count: 0 } as never);
    const send = vi.fn();
    const res = await processDueNudges({ now: NOW, send, resolveEvent: () => Promise.resolve(null) });
    expect(send).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
  });

  it("does not throw (or abort the batch) when a finalize DB update fails", async () => {
    // e.g. the recurring nudge was cancelled/deleted mid-send → re-arm update P2025.
    vi.mocked(prisma.nudge.findMany).mockResolvedValue([{ ...base, recurrenceRule: "FREQ=DAILY" }] as never);
    vi.mocked(prisma.nudge.update).mockRejectedValue(new Error("Record to update not found"));
    const send = vi.fn().mockResolvedValue(undefined);
    // Must resolve, not reject.
    const res = await processDueNudges({ now: NOW, send, resolveEvent: () => Promise.resolve(null) });
    expect(send).toHaveBeenCalledOnce();
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
