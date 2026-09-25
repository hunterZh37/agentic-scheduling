import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ITEM_TITLE_MAX } from "@/lib/todos/items";

export const runtime = "nodejs";

// Check off, rename, or remove one item of an actionable's to-do list
// (private). The item must belong to the actionable in the URL: an id alone
// never reaches another actionable's list.

type Params = { params: Promise<{ id: string; itemId: string }> };

export async function PATCH(req: NextRequest, ctx: Params): Promise<NextResponse> {
  const { id, itemId } = await ctx.params;
  let body: { title?: unknown; done?: unknown };
  try {
    body = (await req.json()) as { title?: unknown; done?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const data: { title?: string; done?: boolean } = {};
  if (body.title !== undefined) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t || t.length > ITEM_TITLE_MAX) {
      return NextResponse.json({ error: "invalid_input", message: "title cannot be empty." }, { status: 400 });
    }
    data.title = t;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") {
      return NextResponse.json({ error: "invalid_input", message: "done must be a boolean." }, { status: 400 });
    }
    data.done = body.done;
  }
  const r = await prisma.todoItem.updateMany({ where: { id: itemId, todoId: id }, data });
  if (r.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const item = await prisma.todoItem.findUnique({ where: { id: itemId } });
  return NextResponse.json({ item });
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<NextResponse> {
  const { id, itemId } = await ctx.params;
  const r = await prisma.todoItem.deleteMany({ where: { id: itemId, todoId: id } });
  if (r.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ deleted: itemId });
}
