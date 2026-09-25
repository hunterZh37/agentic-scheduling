import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ITEM_TITLE_MAX } from "@/lib/todos/items";

export const runtime = "nodejs";

// Quick-add one item to an actionable's to-do list (private). The panel's
// "+ add" box and the agent's add_todo_items use this; the editor's full
// replacement goes through PATCH /api/todos/[id] instead.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: { title?: unknown };
  try {
    body = (await req.json()) as { title?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > ITEM_TITLE_MAX) {
    return NextResponse.json(
      { error: "invalid_input", message: `title is required, at most ${ITEM_TITLE_MAX} characters.` },
      { status: 400 }
    );
  }
  const todo = await prisma.todo.findUnique({ where: { id }, select: { id: true } });
  if (!todo) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const last = await prisma.todoItem.findFirst({ where: { todoId: id }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const item = await prisma.todoItem.create({ data: { todoId: id, title, sortOrder: (last?.sortOrder ?? -1) + 1 } });
  return NextResponse.json({ item }, { status: 201 });
}
