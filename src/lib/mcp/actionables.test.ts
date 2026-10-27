import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

// "Today Claude can create_actionable over MCP but can't change or remove one,
// so rescheduling creates duplicates" (owner, 2026-10-26). Three private tools
// close the gap. The tier boundary is the security property: none of them may
// be visible to, or callable by, a caller without the bearer token.

vi.mock("@/lib/db", () => ({
  prisma: {
    todo: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/todos/service", async (orig) => {
  const real = await orig<typeof import("@/lib/todos/service")>();
  return {
    ...real,
    applyTodoUpdate: vi.fn(),
    deleteTodo: vi.fn(),
    listTodosBetween: vi.fn(),
  };
});
vi.mock("@/lib/schedule/service", () => ({
  getScheduleView: vi.fn(async () => ({ events: [], blocks: [], bookings: [], birthdays: [], actionables: [], warnings: [] })),
}));

import { prisma } from "@/lib/db";
import { applyTodoUpdate, deleteTodo, listTodosBetween } from "@/lib/todos/service";
import { handleRpc } from "./rpc";
import { MCP_TOOLS } from "./tools";

const NEW = ["list_actionables", "update_actionable", "delete_actionable"];
const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;
const call = (method: string, params?: Record<string, unknown>, authed = false) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method, params }, authed);
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
};

const local = (s: string) => DateTime.fromISO(s, { zone: OWNER_TIMEZONE });
const dayKey = (s: string) => local(s).startOf("day").toUTC().toJSDate();
const row = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  title: "Keith: legal update",
  done: false,
  date: dayKey("2026-10-28"),
  startTime: null,
  endTime: null,
  notes: null,
  recurringTodoId: null,
  items: [{ id: "i1", title: "Draft", done: true, sortOrder: 0 }],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("auth tier", () => {
  it("the three tools are private", () => {
    for (const n of NEW) expect(tool(n).tier).toBe("private");
  });

  it("are hidden from an unauthenticated tools/list", async () => {
    const r = (await call("tools/list", {}, false)) as { result: { tools: Array<{ name: string }> } };
    const names = r.result.tools.map((t) => t.name);
    for (const n of NEW) expect(names).not.toContain(n);
  });

  it("are listed once authenticated", async () => {
    const r = (await call("tools/list", {}, true)) as { result: { tools: Array<{ name: string }> } };
    const names = r.result.tools.map((t) => t.name);
    for (const n of NEW) expect(names).toContain(n);
  });

  it("refuse an unauthenticated call with the same error as an unknown tool", async () => {
    for (const n of NEW) {
      const r = (await call("tools/call", { name: n, arguments: { id: "t1" } }, false)) as { error: { code: number } };
      expect(r.error.code).toBe(-32002);
    }
    expect(deleteTodo).not.toHaveBeenCalled();
    expect(applyTodoUpdate).not.toHaveBeenCalled();
    expect(listTodosBetween).not.toHaveBeenCalled();
  });

  it("delete_actionable warns that it is destructive and occurrence-scoped", () => {
    const d = tool("delete_actionable").description;
    expect(d).toContain("Destructive and irreversible. Confirm with the owner before calling.");
    expect(d).toMatch(/recurring/i);
    expect(d).toMatch(/one occurrence/i);
    expect(d).toMatch(/carried over/i);
  });
});

describe("list_actionables", () => {
  it("returns timed and untimed rows with day, items and notes", async () => {
    vi.mocked(listTodosBetween).mockResolvedValue([
      row(),
      row({ id: "t2", title: "IoG user testing setup", startTime: local("2026-10-29T09:00").toJSDate(), endTime: local("2026-10-29T10:00").toJSDate(), date: dayKey("2026-10-29"), notes: "room 4", items: [] }),
    ] as never);
    const out = (await tool("list_actionables").run({ startISO: "2026-10-27T00:00:00Z", endISO: "2026-11-30T23:59:59Z" })) as {
      actionables: Array<Record<string, unknown>>;
      timezone: string;
    };
    expect(out.timezone).toBe(OWNER_TIMEZONE);
    expect(out.actionables[0]).toEqual({
      id: "t1", title: "Keith: legal update", day: "2026-10-28", start: null, end: null, done: false, recurring: false,
      items: [{ id: "i1", title: "Draft", done: true }], notes: null,
    });
    expect(out.actionables[1]).toMatchObject({
      id: "t2", day: "2026-10-29", start: local("2026-10-29T09:00").toUTC().toISO(), notes: "room 4", items: [],
    });
  });

  it("rejects a reversed, unparseable or over-wide range", async () => {
    expect(await rejection(tool("list_actionables").run({ startISO: "2026-11-30", endISO: "2026-10-27" }))).toMatch(/before/);
    expect(await rejection(tool("list_actionables").run({ startISO: "nope", endISO: "2026-10-27" }))).toMatch(/startISO/);
    expect(await rejection(tool("list_actionables").run({ startISO: "2026-01-01", endISO: "2028-01-01" }))).toMatch(/366 days/);
  });

  it("passes the exclusive end straight through to the service", async () => {
    vi.mocked(listTodosBetween).mockResolvedValue([]);
    await tool("list_actionables").run({ startISO: "2026-10-27T04:00:00Z", endISO: "2026-10-28T04:00:00Z" });
    const [s, e] = vi.mocked(listTodosBetween).mock.calls[0];
    expect(s.toISOString()).toBe("2026-10-27T04:00:00.000Z");
    expect(e.toISOString()).toBe("2026-10-28T04:00:00.000Z");
  });

  it("get_schedule also includes untimed actionables, with ids", async () => {
    vi.mocked(listTodosBetween).mockResolvedValue([row()] as never);
    const out = (await tool("get_schedule").run({ startISO: "2026-10-28T00:00:00Z", endISO: "2026-10-29T00:00:00Z" })) as {
      actionables: Array<{ id: string; start: string | null }>;
    };
    expect(out.actionables).toEqual([expect.objectContaining({ id: "t1", start: null, end: null })]);
  });
});

describe("update_actionable", () => {
  const timed = () => row({ startTime: local("2026-10-28T10:00").toJSDate(), endTime: local("2026-10-28T11:00").toJSDate() });
  beforeEach(() => {
    vi.mocked(prisma.todo.findUnique).mockResolvedValue(row() as never);
    vi.mocked(applyTodoUpdate).mockImplementation(async (id, data, items) => row({ id, ...data, items: items ?? row().items }) as never);
  });

  it("moving a timed actionable by day alone carries its times to the new day", async () => {
    vi.mocked(prisma.todo.findUnique).mockResolvedValue(timed() as never);
    await tool("update_actionable").run({ id: "t1", dayISO: "2026-11-04" });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data.date?.getTime()).toBe(dayKey("2026-11-04").getTime());
    expect(data.startTime?.toISOString()).toBe(local("2026-11-04T10:00").toUTC().toISO());
    expect(data.endTime?.toISOString()).toBe(local("2026-11-04T11:00").toUTC().toISO());
  });

  it("moving an untimed actionable by day alone touches only the day", async () => {
    await tool("update_actionable").run({ id: "t1", dayISO: "2026-11-04" });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data).toEqual({ date: dayKey("2026-11-04") });
  });

  it("one end alone keeps the other stored end on a timed actionable", async () => {
    vi.mocked(prisma.todo.findUnique).mockResolvedValue(timed() as never);
    await tool("update_actionable").run({ id: "t1", endISO: local("2026-10-28T12:30").toISO() });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data.startTime?.toISOString()).toBe(local("2026-10-28T10:00").toUTC().toISO());
    expect(data.endTime?.toISOString()).toBe(local("2026-10-28T12:30").toUTC().toISO());
    expect(data.date?.getTime()).toBe(dayKey("2026-10-28").getTime());
    // But an untimed one has nothing to keep.
    vi.mocked(prisma.todo.findUnique).mockResolvedValue(row() as never);
    expect(await rejection(tool("update_actionable").run({ id: "t1", endISO: local("2026-10-28T12:30").toISO() }))).toMatch(/pass both/);
  });

  it("done and clearTime must be real booleans", async () => {
    expect(await rejection(tool("update_actionable").run({ id: "t1", done: "true" }))).toMatch(/done must be true or false/);
    expect(await rejection(tool("update_actionable").run({ id: "t1", clearTime: 1 }))).toMatch(/clearTime must be true or false/);
    expect(applyTodoUpdate).not.toHaveBeenCalled();
  });

  it("errors clearly on an unknown id", async () => {
    vi.mocked(prisma.todo.findUnique).mockResolvedValue(null);
    expect(await rejection(tool("update_actionable").run({ id: "ghost", done: true }))).toMatch(/No actionable with id ghost/);
    expect(applyTodoUpdate).not.toHaveBeenCalled();
  });

  it("requires start before end", async () => {
    const m = await rejection(tool("update_actionable").run({ id: "t1", startISO: local("2026-10-28T10:00").toISO(), endISO: local("2026-10-28T09:00").toISO() }));
    expect(m).toMatch(/endISO must be after startISO/);
  });

  it("requires both instants on the given day in the owner's timezone", async () => {
    const m = await rejection(tool("update_actionable").run({
      id: "t1", dayISO: "2026-10-28", startISO: local("2026-10-29T09:00").toISO(), endISO: local("2026-10-29T10:00").toISO(),
    }));
    expect(m).toMatch(/must both fall on 2026-10-28/);
    const spill = await rejection(tool("update_actionable").run({
      id: "t1", startISO: local("2026-10-28T23:00").toISO(), endISO: local("2026-10-29T01:00").toISO(),
    }));
    expect(spill).toMatch(/must both fall on 2026-10-28/);
  });

  it("without dayISO the day follows the new start", async () => {
    await tool("update_actionable").run({ id: "t1", startISO: local("2026-11-03T14:00").toISO(), endISO: local("2026-11-03T15:00").toISO() });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data.date?.getTime()).toBe(dayKey("2026-11-03").getTime());
    expect(data.startTime?.toISOString()).toBe(local("2026-11-03T14:00").toUTC().toISO());
  });

  it("clearTime makes it all-day again and moves the day when asked", async () => {
    await tool("update_actionable").run({ id: "t1", clearTime: true, dayISO: "2026-11-05" });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data).toEqual({ startTime: null, endTime: null, date: dayKey("2026-11-05") });
    expect(await rejection(tool("update_actionable").run({ id: "t1", clearTime: true, startISO: "x", endISO: "y" }))).toMatch(/clearTime/);
  });

  it("marks done, retitles, replaces notes", async () => {
    await tool("update_actionable").run({ id: "t1", done: true, title: "  Keith: legal update (sent) ", notes: "" });
    const [, data] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(data).toEqual({ done: true, title: "Keith: legal update (sent)", notes: null });
    expect(await rejection(tool("update_actionable").run({ id: "t1", title: "  " }))).toMatch(/title/);
    expect(await rejection(tool("update_actionable").run({ id: "t1" }))).toMatch(/nothing to update/);
  });

  it("re-sends the list with keepItemState so a checked item stays checked at write time", async () => {
    await tool("update_actionable").run({ id: "t1", items: ["Draft", "Send"] });
    const [, , items, opts] = vi.mocked(applyTodoUpdate).mock.calls[0];
    expect(items).toEqual([{ title: "Draft" }, { title: "Send" }]);
    expect(opts).toEqual({ keepItemState: true });
  });

  it("returns the updated actionable in the list shape", async () => {
    const out = (await tool("update_actionable").run({ id: "t1", done: true })) as { ok: boolean; actionable: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.actionable).toMatchObject({ id: "t1", done: true, day: "2026-10-28", items: [{ id: "i1", title: "Draft", done: true }] });
  });
});

describe("delete_actionable", () => {
  it("deletes through the shared service and reports title and day", async () => {
    vi.mocked(deleteTodo).mockResolvedValue({ todo: row({ recurringTodoId: "r1" }), carriedFrom: 2 } as never);
    const out = await tool("delete_actionable").run({ id: "t1" });
    expect(deleteTodo).toHaveBeenCalledWith("t1");
    expect(out).toEqual({ ok: true, deleted: { id: "t1", title: "Keith: legal update", day: "2026-10-28", recurring: true, carriedFrom: 2 } });
  });

  it("errors clearly on an unknown id", async () => {
    vi.mocked(deleteTodo).mockResolvedValue(null);
    expect(await rejection(tool("delete_actionable").run({ id: "ghost" }))).toMatch(/No actionable with id ghost/);
    expect(await rejection(tool("delete_actionable").run({}))).toMatch(/id is required/);
  });
});
