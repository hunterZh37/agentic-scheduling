import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Crossed-off ("done") marks for agenda items that have no DB row of their own
// (calendar events, bookings). Presence of a Checkoff row = done. Blocks/todos
// persist `done` on their own models and don't use this.

// GET → { keys: string[] } — every currently-checked item key.
export async function GET(): Promise<NextResponse> {
  const rows = await prisma.checkoff.findMany({ select: { key: true } });
  return NextResponse.json({ keys: rows.map((r) => r.key) });
}

interface CheckoffBody {
  key?: string;
  done?: boolean;
}

// POST { key, done } — mark an item done (create) or not-done (delete).
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: CheckoffBody;
  try {
    body = (await req.json()) as CheckoffBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const key = body.key?.trim();
  if (!key || typeof body.done !== "boolean") {
    return NextResponse.json(
      { error: "invalid_input", message: "key (string) and done (boolean) are required." },
      { status: 400 }
    );
  }

  if (body.done) {
    // Idempotent: upsert so a double-check doesn't error.
    await prisma.checkoff.upsert({ where: { key }, create: { key }, update: {} });
  } else {
    // Idempotent: ignore "record not found" so a double-uncheck is a no-op.
    await prisma.checkoff.deleteMany({ where: { key } });
  }
  return NextResponse.json({ key, done: body.done });
}
