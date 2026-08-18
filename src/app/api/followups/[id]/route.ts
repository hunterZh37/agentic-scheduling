import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Toggle done / rename / delete a single follow-up. `id` is the EventFollowup row id.

interface FollowupPatchBody {
  done?: boolean;
  title?: string;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: FollowupPatchBody;
  try {
    body = (await req.json()) as FollowupPatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const data: Prisma.EventFollowupUpdateInput = {};
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    data.done = body.done;
  }
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "invalid_input", message: "title cannot be empty." }, { status: 400 });
    data.title = title;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "invalid_input", message: "Nothing to update." }, { status: 400 });
  }

  try {
    const followup = await prisma.eventFollowup.update({ where: { id }, data });
    return NextResponse.json({ followup });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await prisma.eventFollowup.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
