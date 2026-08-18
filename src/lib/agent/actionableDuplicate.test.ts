import { describe, it, expect, vi, beforeEach } from "vitest";

// The owner asked the agent for one actionable, then in a FOLLOW-UP turn asked
// for a second, unrelated one. The agent created the second — and re-created the
// first, leaving "Put together all the immigration things" on the list twice at
// 8–10 PM.
//
// Why it is possible at all: run.ts replays conversation history to the model as
// plain role + content text, so a previous tool call leaves no structured trace.
// The model's only memory of having acted is its own prose, and when it writes a
// combined "both are on tonight's list" confirmation, calling create for both is
// an easy mistake. #21 gave it list/update/delete so it had a better option;
// that is advice, and advice is not a guard.

vi.mock("@/lib/db", () => ({
  prisma: { todo: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("@/lib/clientConfig", () => ({ OWNER_TIMEZONE: "America/Los_Angeles" }));

import { createActionableTool } from "./tools";
import { prisma } from "@/lib/db";

const tool = createActionableTool();
const run = (args: Record<string, unknown>) =>
  (tool.run as (a: Record<string, unknown>) => Promise<string>)(args).then(JSON.parse);

// 8–10 PM Pacific on 11 Aug 2026, the actual duplicated item.
const IMMIGRATION = {
  title: "Put together all the immigration things",
  dayISO: "2026-08-11T12:00:00-07:00",
  startISO: "2026-08-12T03:00:00.000Z",
  endISO: "2026-08-12T05:00:00.000Z",
};
const existing = {
  id: "todo_existing",
  title: "Put together all the immigration things",
  startTime: new Date(IMMIGRATION.startISO),
  endTime: new Date(IMMIGRATION.endISO),
};

beforeEach(() => {
  vi.mocked(prisma.todo.findFirst).mockReset();
  vi.mocked(prisma.todo.create).mockReset().mockResolvedValue({ id: "todo_new" } as never);
});

/// findFirst serves both the duplicate probe and the sortOrder lookup. `dupe`
/// decides what the probe finds.
const withExisting = (dupe: unknown) => {
  vi.mocked(prisma.todo.findFirst).mockImplementation((async (args: {
    where?: { title?: unknown };
  }) => (args?.where?.title ? dupe : { sortOrder: 3 })) as never);
};

describe("create_actionable does not write the same item twice", () => {
  it("returns the existing actionable instead of creating a second", async () => {
    withExisting(existing);

    const res = await run(IMMIGRATION);

    expect(res).toMatchObject({ ok: true, todoId: "todo_existing", duplicate: true });
    expect(prisma.todo.create).not.toHaveBeenCalled();
  });

  it("creates normally when nothing matches", async () => {
    withExisting(null);

    const res = await run(IMMIGRATION);

    expect(res).toMatchObject({ ok: true, todoId: "todo_new" });
    expect(res.duplicate).toBeUndefined();
    expect(prisma.todo.create).toHaveBeenCalledTimes(1);
  });

  it("matches on the day, the title and BOTH ends of the time range", async () => {
    withExisting(existing);

    await run(IMMIGRATION);

    const where = vi.mocked(prisma.todo.findFirst).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.title).toEqual({ equals: IMMIGRATION.title, mode: "insensitive" });
    expect(where.startTime).toEqual(new Date(IMMIGRATION.startISO));
    expect(where.endTime).toEqual(new Date(IMMIGRATION.endISO));
    expect(where.date).toBeInstanceOf(Date);
  });

  it("ignores case and surrounding whitespace, which is how a retyped title differs", async () => {
    withExisting(existing);

    const res = await run({ ...IMMIGRATION, title: "  put together ALL the immigration things " });

    // The title is trimmed before the probe and compared case-insensitively.
    const where = vi.mocked(prisma.todo.findFirst).mock.calls[0][0]!.where as {
      title: { equals: string };
    };
    expect(where.title.equals).toBe("put together ALL the immigration things");
    expect(res.duplicate).toBe(true);
  });

  it("still allows the same title at a DIFFERENT time", async () => {
    // Two "Gym" entries in one day are legitimate; only an exact repeat is not.
    // The probe pins the times, so a different range simply finds nothing.
    withExisting(null);

    const res = await run({
      ...IMMIGRATION,
      startISO: "2026-08-12T16:00:00.000Z",
      endISO: "2026-08-12T17:00:00.000Z",
    });

    expect(res.duplicate).toBeUndefined();
    expect(prisma.todo.create).toHaveBeenCalledTimes(1);
  });

  it("treats two untimed items with the same title on a day as the same item", async () => {
    withExisting({ id: "todo_untimed", title: "Call the lawyer" });

    const res = await run({ title: "Call the lawyer", dayISO: IMMIGRATION.dayISO });

    const where = vi.mocked(prisma.todo.findFirst).mock.calls[0][0]!.where as Record<string, unknown>;
    // null, not undefined: undefined would drop the condition and match any
    // timed item with that title.
    expect(where.startTime).toBeNull();
    expect(where.endTime).toBeNull();
    expect(res).toMatchObject({ todoId: "todo_untimed", duplicate: true });
  });
});
