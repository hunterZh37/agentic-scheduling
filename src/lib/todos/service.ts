import { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { dayKey } from "@/lib/todos/carryForward";
import { diffItems, withItems, type IncomingItem, type ItemRow } from "@/lib/todos/items";

/// The one place an actionable (Todo) is changed or removed. The private HTTP
/// route (`/api/todos/[id]`) and the MCP tools both call these, so an agent
/// editing over MCP reconciles a to-do list exactly the way the dashboard does.
/// A second copy of this logic is how the create-only MCP surface produced
/// duplicates in the first place (docs/REGRESSIONS.md #70).

export type TodoUpdateData = {
  title?: string;
  done?: boolean;
  date?: Date;
  startTime?: Date | null;
  endTime?: Date | null;
  location?: string | null;
  videoLink?: string | null;
  phone?: string | null;
  notes?: string | null;
};

export type TodoWithItems = Prisma.TodoGetPayload<{ include: typeof withItems }>;

export const isNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";

/// Carry the stored `done` state (and id) onto an incoming replacement list
/// when the caller did not say otherwise. An agent re-sending a list as plain
/// titles must not silently un-check what the owner already ticked: an item
/// that matches an existing one by id, or by title when it has no id, adopts
/// that item's id, and its `done` when the caller left it undefined. Pure.
export function mergeItemState(existing: ItemRow[], incoming: IncomingItem[]): IncomingItem[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const claimed = new Set<string>();
  const norm = (s: string) => s.trim().toLowerCase();
  // Explicit ids claim first, so a title-only entry can never steal the row
  // an explicit entry later in the list was pointing at.
  const matched: (ItemRow | undefined)[] = incoming.map((inc) => {
    if (inc.id && byId.has(inc.id) && !claimed.has(inc.id)) {
      claimed.add(inc.id);
      return byId.get(inc.id);
    }
    return undefined;
  });
  incoming.forEach((inc, i) => {
    if (matched[i] || inc.id) return;
    const m = existing.find((e) => !claimed.has(e.id) && norm(e.title) === norm(inc.title));
    if (m) {
      claimed.add(m.id);
      matched[i] = m;
    }
  });
  return incoming.map((inc, i) => {
    const m = matched[i];
    return m ? { id: m.id, title: inc.title, done: inc.done ?? m.done } : inc;
  });
}

/// Apply a field update and, when `items` is given, a full replacement of the
/// to-do list (diffItems: owned ids update, new titles create, absent ids go).
/// With `keepItemState`, the incoming list is first reconciled against the
/// stored one (mergeItemState) INSIDE the transaction, so a tick made between
/// the caller's read and this write is never overwritten with stale state.
/// Returns null when no todo has that id.
export async function applyTodoUpdate(
  id: string,
  data: TodoUpdateData,
  items?: IncomingItem[],
  opts: { keepItemState?: boolean } = {}
): Promise<TodoWithItems | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (items) {
        const existing = await tx.todoItem.findMany({ where: { todoId: id }, select: { id: true, title: true, done: true } });
        const d = diffItems(existing, opts.keepItemState ? mergeItemState(existing, items) : items);
        if (d.delete.length) await tx.todoItem.deleteMany({ where: { id: { in: d.delete }, todoId: id } });
        for (const u of d.update) {
          // Scoped and count-tolerant: an item removed by another tab between
          // the read and this write is simply gone, not a 404 for the todo.
          await tx.todoItem.updateMany({
            where: { id: u.id, todoId: id },
            data: { title: u.title, done: u.done, sortOrder: u.sortOrder },
          });
        }
        if (d.create.length) await tx.todoItem.createMany({ data: d.create.map((c) => ({ ...c, todoId: id })) });
      }
      return tx.todo.update({ where: { id }, data, include: withItems });
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/// Delete one actionable and return the row that was removed (so the caller
/// can say what went), or null when there was none. Items cascade. A seeded
/// occurrence of a recurring template is one row like any other: the template
/// is untouched and keeps seeding later days; the cron never re-seeds a day it
/// has already run through (`lastMaterializedOn`), so the gap stays.
///
/// A CARRIED copy (`rolledFromId` set) is the same task rolled over from an
/// unfinished earlier day. Deleting just the copy is not a delete: the next
/// carry-forward (every page load, the cron) sees the source still undone and
/// uncarried and makes the copy again. So the undone source chain behind it
/// goes too, and `carriedFrom` says how many earlier-day rows that was.
export async function deleteTodo(id: string): Promise<{ todo: TodoWithItems; carriedFrom: number } | null> {
  const todo = await prisma.todo.findUnique({ where: { id }, include: withItems });
  if (!todo) return null;
  const chain: string[] = [];
  let from = todo.rolledFromId;
  while (from && !chain.includes(from) && chain.length < 400) {
    const src = await prisma.todo.findUnique({ where: { id: from }, select: { id: true, rolledFromId: true, done: true } });
    if (!src || src.done) break;
    chain.push(src.id);
    from = src.rolledFromId;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.todo.delete({ where: { id } });
      if (chain.length) await tx.todo.deleteMany({ where: { id: { in: chain } } });
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return { todo, carriedFrom: chain.length };
}

/// Every actionable, timed or not, on a day that overlaps [start, end): from
/// the owner-local day `start` falls on, up to but excluding a day that begins
/// at or after `end`. So next-midnight-exclusive ranges return exactly the days
/// between, and an instant late on a day includes that day. Day order, then
/// list order.
export async function listTodosBetween(start: Date, end: Date): Promise<TodoWithItems[]> {
  const from = dayKey(DateTime.fromJSDate(start));
  return prisma.todo.findMany({
    where: { date: { gte: from, lt: end } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }, { sortOrder: "asc" }],
    include: withItems,
  });
}

/// The owner-local calendar day ("2026-10-27") an actionable belongs to.
export function todoDay(date: Date): string {
  return DateTime.fromJSDate(date).setZone(OWNER_TIMEZONE).toISODate() ?? "";
}
