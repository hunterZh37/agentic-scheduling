import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Follow-up actionables attached to a calendar-event occurrence. Each row's
// eventKey uses the "event:<providerEventId>:<startISO>" format (same as the
// Checkoff store), so the agenda and modal look items up by the occurrence they
// belong to. See src/lib/followups/key.ts.

// GET → { followups: EventFollowup[] }. Without a query param, returns every
// follow-up (the agenda groups them by eventKey — single-user scale is tiny).
// With ?eventKey=<key>, returns just that occurrence's list (used by the modal).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const eventKey = req.nextUrl.searchParams.get("eventKey")?.trim();
  const followups = await prisma.eventFollowup.findMany({
    where: eventKey ? { eventKey } : undefined,
    orderBy: [{ eventKey: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ followups });
}

interface FollowupBody {
  eventKey?: string;
  title?: string;
}

// POST { eventKey, title } — append a new follow-up to an occurrence. New items
// sort after existing ones for that key.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: FollowupBody;
  try {
    body = (await req.json()) as FollowupBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventKey = body.eventKey?.trim();
  const title = body.title?.trim();
  if (!eventKey || !title) {
    return NextResponse.json(
      { error: "invalid_input", message: "eventKey and title are required." },
      { status: 400 }
    );
  }

  const last = await prisma.eventFollowup.findFirst({
    where: { eventKey },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const followup = await prisma.eventFollowup.create({
    data: { eventKey, title, sortOrder: (last?.sortOrder ?? -1) + 1 },
  });
  return NextResponse.json({ followup }, { status: 201 });
}
