import { describe, it, expect, vi, beforeEach } from "vitest";

// The to-do list tools (replaced the four follow-up tools, 2026-09-24). Pinned:
// every write is scoped to the actionable in the call, so an item id alone can
// never reach another actionable's list; titles are cleaned the same way the
// API cleans them; and create_actionable carries items in one call, which is
// what lets a list-shaped request become ONE actionable.
vi.mock("@/lib/db", () => ({
  prisma: {
    todo: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    todoItem: { findMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/clientConfig", () => ({ OWNER_TIMEZONE: "America/Los_Angeles" }));

import { addTodoItemsTool, setTodoItemDoneTool, removeTodoItemTool, createActionableTool } from "./tools";
import { prisma } from "@/lib/db";

const todo = vi.mocked(prisma.todo) as unknown as { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
const todoItem = vi.mocked(prisma.todoItem) as unknown as { findMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };

const run = async (tool: unknown, input: unknown) =>
  JSON.parse(await (tool as { run: (i: unknown) => Promise<string> }).run(input));

beforeEach(() => {
  vi.resetAllMocks();
  todo.findUnique.mockResolvedValue({ id: "t1" });
  todoItem.findMany.mockResolvedValue([]);
  todoItem.createMany.mockResolvedValue({ count: 1 });
});

describe("add_todo_items", () => {
  it("appends cleaned titles after the existing ones", async () => {
    todoItem.findMany
      .mockResolvedValueOnce([{ sortOrder: 4 }])
      .mockResolvedValueOnce([{ id: "a", title: "Old", done: true, sortOrder: 4 }, { id: "b", title: "Send links", done: false, sortOrder: 5 }]);
    const r = await run(addTodoItemsTool(), { actionableId: "t1", titles: ["  Send links ", "   "] });
    expect(todoItem.createMany).toHaveBeenCalledWith({ data: [{ title: "Send links", done: false, sortOrder: 5, todoId: "t1" }] });
    expect(r.progress).toEqual({ done: 1, total: 2 });
  });

  it("refuses an unknown actionable and an empty list", async () => {
    todo.findUnique.mockResolvedValueOnce(null);
    expect((await run(addTodoItemsTool(), { actionableId: "nope", titles: ["x"] })).error).toBe("not_found");
    expect((await run(addTodoItemsTool(), { actionableId: "t1", titles: ["  "] })).error).toBe("missing_titles");
    expect(todoItem.createMany).not.toHaveBeenCalled();
  });
});

describe("set_todo_item_done and remove_todo_item", () => {
  it("scope every write to the actionable in the call", async () => {
    todoItem.updateMany.mockResolvedValue({ count: 1 });
    await run(setTodoItemDoneTool(), { actionableId: "t1", itemId: "i9" });
    expect(todoItem.updateMany).toHaveBeenCalledWith({ where: { id: "i9", todoId: "t1" }, data: { done: true } });
    todoItem.deleteMany.mockResolvedValue({ count: 1 });
    await run(removeTodoItemTool(), { actionableId: "t1", itemId: "i9" });
    expect(todoItem.deleteMany).toHaveBeenCalledWith({ where: { id: "i9", todoId: "t1" } });
  });

  it("reports not_found when the item is not on that actionable", async () => {
    todoItem.updateMany.mockResolvedValue({ count: 0 });
    expect((await run(setTodoItemDoneTool(), { actionableId: "t1", itemId: "other", done: false })).error).toBe("not_found");
  });
});

describe("create_actionable with items", () => {
  it("creates the actionable and its list in one write", async () => {
    todo.findFirst.mockResolvedValue(null);
    todo.create.mockImplementation(async ({ data }: { data: { items?: { create: unknown[] } } }) => ({
      id: "new",
      items: (data.items?.create ?? []).map((c, i) => ({ id: `i${i}`, ...(c as object) })),
    }));
    const r = await run(createActionableTool(), {
      title: "Keith meeting prep",
      dayISO: "2026-09-09T12:00:00Z",
      items: ["Send Keith the links", "Remove Stephanie from Salesforce"],
    });
    expect(todo.create).toHaveBeenCalledTimes(1);
    expect(todo.create.mock.calls[0][0].data.items).toEqual({
      create: [
        { title: "Send Keith the links", done: false, sortOrder: 0 },
        { title: "Remove Stephanie from Salesforce", done: false, sortOrder: 1 },
      ],
    });
    expect(r.progress).toEqual({ done: 0, total: 2 });
    expect(r.items).toHaveLength(2);
  });
});
