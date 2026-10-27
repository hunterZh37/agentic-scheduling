import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Over MCP, Claude could create an actionable but not change or remove one, so
// a reschedule meant a second copy (owner, 2026-10-26; docs/REGRESSIONS.md #70).
// The fix routes the dashboard's PATCH/DELETE and the MCP tools through ONE
// service, and that service must keep what the owner already ticked.

const tx = {
  todoItem: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  todo: { update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    todo: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { applyTodoUpdate, deleteTodo, listTodosBetween, mergeItemState } from "./service";

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "test" });

beforeEach(() => vi.clearAllMocks());

describe("mergeItemState", () => {
  const existing = [
    { id: "a", title: "Draft the deck", done: true },
    { id: "b", title: "Send it", done: false },
  ];

  it("keeps a checked item checked when the caller re-sends it by title only", () => {
    const out = mergeItemState(existing, [{ title: "Draft the deck" }, { title: "Send it" }]);
    expect(out).toEqual([
      { id: "a", title: "Draft the deck", done: true },
      { id: "b", title: "Send it", done: false },
    ]);
  });

  it("matches by id first and lets an explicit done win", () => {
    const out = mergeItemState(existing, [{ id: "a", title: "Draft the deck v2", done: false }]);
    expect(out).toEqual([{ id: "a", title: "Draft the deck v2", done: false }]);
  });

  it("title match is case- and whitespace-insensitive and claims each item once", () => {
    const out = mergeItemState(existing, [{ title: "  draft the DECK " }, { title: "Draft the deck" }]);
    expect(out[0]).toEqual({ id: "a", title: "  draft the DECK ", done: true });
    expect(out[1]).toEqual({ title: "Draft the deck" });
  });

  it("leaves a genuinely new item alone", () => {
    expect(mergeItemState(existing, [{ title: "Book travel" }])).toEqual([{ title: "Book travel" }]);
  });

  it("an explicit id later in the list wins over an earlier title-only match", () => {
    const out = mergeItemState([{ id: "a", title: "x", done: true }], [{ title: "x" }, { id: "a", title: "y" }]);
    expect(out).toEqual([{ title: "x" }, { id: "a", title: "y", done: true }]);
  });
});

describe("applyTodoUpdate", () => {
  it("reconciles the list inside the transaction and returns the updated row", async () => {
    tx.todoItem.findMany.mockResolvedValue([
      { id: "a", title: "Draft", done: true },
      { id: "b", title: "Send", done: false },
    ]);
    tx.todo.update.mockResolvedValue({ id: "t1", title: "Keith: legal update", items: [] });
    const out = await applyTodoUpdate("t1", { title: "Keith: legal update" }, [
      { id: "a", title: "Draft", done: true },
      { title: "Call" },
    ]);
    expect(out?.id).toBe("t1");
    expect(tx.todoItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["b"] }, todoId: "t1" } });
    expect(tx.todoItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a", todoId: "t1" },
      data: { title: "Draft", done: true, sortOrder: 0 },
    });
    expect(tx.todoItem.createMany).toHaveBeenCalledWith({ data: [{ title: "Call", done: false, sortOrder: 1, todoId: "t1" }] });
    expect(tx.todo.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" }, data: { title: "Keith: legal update" } }));
  });

  it("with keepItemState, reconciles against the list read inside the transaction", async () => {
    // The caller's view may be stale; what counts is the stored state at write time.
    tx.todoItem.findMany.mockResolvedValue([{ id: "a", title: "Draft", done: true }]);
    tx.todo.update.mockResolvedValue({ id: "t1", items: [] });
    await applyTodoUpdate("t1", {}, [{ title: "Draft" }, { title: "Send" }], { keepItemState: true });
    expect(tx.todoItem.updateMany).toHaveBeenCalledWith({
      where: { id: "a", todoId: "t1" },
      data: { title: "Draft", done: true, sortOrder: 0 },
    });
    expect(tx.todoItem.createMany).toHaveBeenCalledWith({ data: [{ title: "Send", done: false, sortOrder: 1, todoId: "t1" }] });
    expect(tx.todoItem.deleteMany).not.toHaveBeenCalled();
  });

  it("touches no items when the list is not part of the update", async () => {
    tx.todo.update.mockResolvedValue({ id: "t1", items: [] });
    await applyTodoUpdate("t1", { done: true });
    expect(tx.todoItem.findMany).not.toHaveBeenCalled();
    expect(tx.todoItem.deleteMany).not.toHaveBeenCalled();
  });

  it("returns null for an unknown id instead of throwing", async () => {
    tx.todo.update.mockRejectedValue(notFound());
    expect(await applyTodoUpdate("nope", { done: true })).toBeNull();
  });
});

describe("deleteTodo", () => {
  const rows: Record<string, { id: string; title: string; rolledFromId: string | null; done: boolean; items: unknown[] }> = {
    t1: { id: "t1", title: "Send drafted messages", rolledFromId: "t0", done: false, items: [] },
    t0: { id: "t0", title: "Send drafted messages", rolledFromId: "tz", done: false, items: [] },
    tz: { id: "tz", title: "Send drafted messages", rolledFromId: null, done: true, items: [] },
    solo: { id: "solo", title: "Keith: legal update", rolledFromId: null, done: false, items: [] },
  };
  beforeEach(() => {
    vi.mocked(prisma.todo.findUnique).mockImplementation((async (q: { where: { id: string } }) => rows[q.where.id] ?? null) as never);
  });

  it("returns the removed row so the caller can say what went", async () => {
    const gone = await deleteTodo("solo");
    expect(gone?.todo.title).toBe("Keith: legal update");
    expect(gone?.carriedFrom).toBe(0);
    expect(tx.todo.delete).toHaveBeenCalledWith({ where: { id: "solo" } });
    expect(tx.todo.deleteMany).not.toHaveBeenCalled();
  });

  it("takes the unfinished carry-forward chain with it, stopping at a done source", async () => {
    // Otherwise the next carry-forward sees t0 undone and uncarried and recreates t1.
    const gone = await deleteTodo("t1");
    expect(gone?.carriedFrom).toBe(1);
    expect(tx.todo.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(tx.todo.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["t0"] } } });
  });

  it("returns null for an unknown id", async () => {
    expect(await deleteTodo("nope")).toBeNull();
    expect(tx.todo.delete).not.toHaveBeenCalled();
  });
});

describe("listTodosBetween", () => {
  it("includes the start's owner-local day and treats end as exclusive, with no timed filter", async () => {
    vi.mocked(prisma.todo.findMany).mockResolvedValue([]);
    const start = new Date("2026-10-27T12:00:00Z"), end = new Date("2026-11-30T12:00:00Z");
    await listTodosBetween(start, end);
    const arg = vi.mocked(prisma.todo.findMany).mock.calls[0][0] as { where: { date: { gte: Date; lt: Date } } };
    expect(arg.where).toEqual({ date: { gte: expect.any(Date), lt: end } });
    // gte is the day-key of the start's local day: at or before the instant, within a day.
    expect(arg.where.date.gte.getTime()).toBeLessThanOrEqual(start.getTime());
    expect(start.getTime() - arg.where.date.gte.getTime()).toBeLessThan(86_400_000);
    // No startTime constraint: untimed rows must come back too.
    expect(JSON.stringify(arg.where)).not.toContain("startTime");
  });
});
