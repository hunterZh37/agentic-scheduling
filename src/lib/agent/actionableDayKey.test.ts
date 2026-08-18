import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";

vi.mock("@/lib/db", () => ({
  prisma: {
    todo: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
  },
}));

import { updateActionableTool, createActionableTool } from "./tools";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

// An actionable carries BOTH a `date` (the day it belongs to — what the Blocks
// checklist queries) and a start/end (what the calendar grid places it by).
// update_actionable rewrote only the times, so "move Planning for Mr. J.J to
// tomorrow" left the row on Aug 6 in the checklist while the calendar drew it on
// Aug 7. One record, two days, and nothing to indicate which was right.
const run = async (tool: unknown, args: Record<string, unknown>) =>
  JSON.parse(await (tool as { run: (a: Record<string, unknown>) => Promise<string> }).run(args));

const localMidnightUtc = (iso: string) =>
  DateTime.fromISO(iso).setZone(OWNER_TIMEZONE).startOf("day").toUTC().toISO();

beforeEach(() => {
  vi.mocked(prisma.todo.findUnique).mockReset().mockResolvedValue({ id: "t1" } as never);
  vi.mocked(prisma.todo.update).mockReset().mockImplementation(
    (async ({ data }: { data: Record<string, unknown> }) => ({
      id: "t1",
      title: "Planning for Mr. J.J",
      startTime: data.startTime ?? null,
      endTime: data.endTime ?? null,
    })) as never
  );
  vi.mocked(prisma.todo.findFirst).mockReset().mockResolvedValue(null as never);
  vi.mocked(prisma.todo.create).mockReset().mockImplementation(
    (async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data })) as never
  );
});

describe("update_actionable keeps the day-key with the start", () => {
  it("moves the day-key when the start moves to another day", async () => {
    await run(updateActionableTool(), {
      id: "t1",
      startISO: "2026-08-08T01:30:00.000Z", // Aug 7, 6:30pm PT
      endISO: "2026-08-08T03:30:00.000Z",
    });
    const { data } = vi.mocked(prisma.todo.update).mock.calls[0][0] as never as {
      data: { date?: Date };
    };
    expect(data.date?.toISOString()).toBe(localMidnightUtc("2026-08-08T01:30:00.000Z"));
  });

  it("leaves the day-key alone when only the time-of-day changes", async () => {
    await run(updateActionableTool(), {
      id: "t1",
      startISO: "2026-08-06T22:00:00.000Z",
      endISO: "2026-08-06T23:00:00.000Z",
    });
    const { data } = vi.mocked(prisma.todo.update).mock.calls[0][0] as never as {
      data: { date?: Date };
    };
    // Still derived, and still the same day — the point is it never disagrees.
    expect(data.date?.toISOString()).toBe(localMidnightUtc("2026-08-06T22:00:00.000Z"));
  });

  it("lets an explicit dayISO win, for filing an item on another day", async () => {
    await run(updateActionableTool(), {
      id: "t1",
      startISO: "2026-08-08T01:30:00.000Z",
      endISO: "2026-08-08T03:30:00.000Z",
      dayISO: "2026-08-10T12:00:00.000Z",
    });
    const { data } = vi.mocked(prisma.todo.update).mock.calls[0][0] as never as {
      data: { date?: Date };
    };
    expect(data.date?.toISOString()).toBe(localMidnightUtc("2026-08-10T12:00:00.000Z"));
  });

  it("does not touch the day-key when the actionable is untimed", async () => {
    await run(updateActionableTool(), { id: "t1", title: "Renamed" });
    const { data } = vi.mocked(prisma.todo.update).mock.calls[0][0] as never as {
      data: { date?: Date };
    };
    expect(data.date).toBeUndefined();
  });
});

describe("create_actionable files it on the day its start falls on", () => {
  it("ignores a dayISO that contradicts the start", async () => {
    await run(createActionableTool(), {
      title: "Planning",
      dayISO: "2026-08-06T12:00:00.000Z", // wrong day
      startISO: "2026-08-08T01:30:00.000Z", // Aug 7 PT
      endISO: "2026-08-08T03:30:00.000Z",
    });
    const { data } = vi.mocked(prisma.todo.create).mock.calls[0][0] as never as {
      data: { date: Date };
    };
    expect(data.date.toISOString()).toBe(localMidnightUtc("2026-08-08T01:30:00.000Z"));
  });

  it("uses dayISO for an untimed actionable, which has no start to follow", async () => {
    await run(createActionableTool(), { title: "Buy milk", dayISO: "2026-08-06T12:00:00.000Z" });
    const { data } = vi.mocked(prisma.todo.create).mock.calls[0][0] as never as {
      data: { date: Date };
    };
    expect(data.date.toISOString()).toBe(localMidnightUtc("2026-08-06T12:00:00.000Z"));
  });
});
