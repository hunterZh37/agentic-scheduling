import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

// Day-level Todo CRUD (private). Backs the "Today" checklist atop the Blocks
// pane agenda — plain to-dos scoped to a calendar day, not tied to any event
// or block. `date` is the day's start as computed by the client (local
// midnight in the owner's timezone, converted to a UTC instant) — treated as an
// opaque, stable day key rather than re-derived server-side, since the
// server has no notion of the owner's timezone.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const date = parseIsoDate(new URL(req.url).searchParams.get("date"));
  if (!date) {
    return NextResponse.json(
      { error: "missing_params", message: "date (ISO 8601) is required." },
      { status: 400 }
    );
  }
  const todos = await prisma.todo.findMany({
    where: { date },
    orderBy: { sortOrder: "asc" },
  });
  return NextResponse.json({ todos });
}

interface TodoBody {
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  // "Where" — at most one is meaningful (in-person location, online meeting
  // link, or a phone number for a call), but the API doesn't enforce that.
  location?: string;
  videoLink?: string;
  phone?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: TodoBody;
  try {
    body = (await req.json()) as TodoBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = body.title?.trim();
  const date = parseIsoDate(body.date);
  if (!title || !date) {
    return NextResponse.json(
      { error: "missing_params", message: "title, date (ISO 8601) are required." },
      { status: 400 }
    );
  }

  // A todo is either UNTIMED (neither provided) or TIMED (both provided, end after start).
  const startTime = body.startTime !== undefined ? parseIsoDate(body.startTime) : undefined;
  const endTime = body.endTime !== undefined ? parseIsoDate(body.endTime) : undefined;
  const wantsStart = body.startTime !== undefined;
  const wantsEnd = body.endTime !== undefined;
  if (wantsStart !== wantsEnd || (wantsStart && (!startTime || !endTime))) {
    return NextResponse.json(
      { error: "invalid_input", message: "startTime and endTime must both be set (ISO 8601) or both omitted." },
      { status: 400 }
    );
  }
  if (startTime && endTime && endTime.getTime() <= startTime.getTime()) {
    return NextResponse.json(
      { error: "invalid_input", message: "endTime must be after startTime." },
      { status: 400 }
    );
  }

  // New todos land at the end of the day's list.
  const last = await prisma.todo.findFirst({
    where: { date },
    orderBy: { sortOrder: "desc" },
  });
  const todo = await prisma.todo.create({
    data: {
      title,
      date,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      location: body.location?.trim() || null,
      videoLink: body.videoLink?.trim() || null,
      phone: body.phone?.trim() || null,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });
  return NextResponse.json({ todo }, { status: 201 });
}
