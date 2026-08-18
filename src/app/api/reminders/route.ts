import { NextRequest, NextResponse } from "next/server";
import { createNudge, listUpcomingNudges, type CreateNudgeInput } from "@/lib/nudge/service";

export const runtime = "nodejs";

// Reminder CRUD (private — not on the public allowlist; the proxy 401s
// unauthenticated /api/ calls). Backs the UI reminder controls.

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ reminders: await listUpcomingNudges() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: CreateNudgeInput;
  try {
    body = (await req.json()) as CreateNudgeInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const res = await createNudge({
    fireAtISO: body.fireAtISO,
    message: body.message,
    event: body.event ?? null,
    recurrenceRule: body.recurrenceRule ?? null,
    eventDateISO: body.eventDateISO ?? null,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ id: res.id, whenLabel: res.whenLabel }, { status: 201 });
}
