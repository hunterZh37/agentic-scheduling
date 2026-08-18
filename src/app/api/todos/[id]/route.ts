import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

// Toggle/rename or delete a single Todo (private).

interface TodoBody {
  title?: string;
  done?: boolean;
  // The calendar day this belongs to (day's start, UTC). Sent when a todo is
  // moved to another day: startTime/endTime alone would leave this stale and
  // the item would keep showing under its old day, since the agenda queries
  // by `date`. Computed client-side as local midnight in the owner's zone,
  // matching POST — the server has no notion of that zone.
  date?: string;
  // Either both set (a TIMED todo) or both explicitly null (clear back to
  // UNTIMED). Omitted fields are left untouched.
  startTime?: string | null;
  endTime?: string | null;
  // "Where" fields. Omitted = untouched; empty string or null = clear.
  location?: string | null;
  videoLink?: string | null;
  phone?: string | null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: TodoBody;
  try {
    body = (await req.json()) as TodoBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.title !== undefined && !body.title.trim()) {
    return NextResponse.json({ error: "invalid_input", message: "title cannot be empty." }, { status: 400 });
  }

  const data: {
    title?: string;
    done?: boolean;
    date?: Date;
    startTime?: Date | null;
    endTime?: Date | null;
    location?: string | null;
    videoLink?: string | null;
    phone?: string | null;
  } = {};
  if (body.title !== undefined) data.title = body.title.trim();
  if (body.date !== undefined) {
    const d = parseIsoDate(body.date);
    if (!d) {
      return NextResponse.json(
        { error: "invalid_input", message: "date must be a valid ISO 8601 timestamp." },
        { status: 400 }
      );
    }
    data.date = d;
  }
  if (typeof body.done === "boolean") data.done = body.done;
  if (body.location !== undefined) data.location = body.location?.trim() || null;
  if (body.videoLink !== undefined) data.videoLink = body.videoLink?.trim() || null;
  if (body.phone !== undefined) data.phone = body.phone?.trim() || null;

  // Time range is updated as a pair: provide both to set a range, both null
  // to clear it, or omit both to leave the existing range untouched.
  const wantsStart = body.startTime !== undefined;
  const wantsEnd = body.endTime !== undefined;
  if (wantsStart || wantsEnd) {
    if (wantsStart !== wantsEnd) {
      return NextResponse.json(
        { error: "invalid_input", message: "startTime and endTime must be updated together." },
        { status: 400 }
      );
    }
    if (body.startTime === null && body.endTime === null) {
      data.startTime = null;
      data.endTime = null;
    } else {
      const startTime = parseIsoDate(body.startTime);
      const endTime = parseIsoDate(body.endTime);
      if (!startTime || !endTime || endTime.getTime() <= startTime.getTime()) {
        return NextResponse.json(
          { error: "invalid_input", message: "startTime and endTime must be valid ISO 8601 with endTime after startTime." },
          { status: 400 }
        );
      }
      data.startTime = startTime;
      data.endTime = endTime;
    }
  }

  try {
    const todo = await prisma.todo.update({ where: { id }, data });
    return NextResponse.json({ todo });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await prisma.todo.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
