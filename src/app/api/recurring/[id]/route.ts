import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { updateRecurringActionable } from "@/lib/todos/recurring";

export const runtime = "nodejs";

interface PatchBody {
  title?: string;
  rrule?: string;
  // Timed occurrence as representative ISO instants (owner-local time-of-day),
  // or null on both to clear the time. Omit to leave the time unchanged.
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  videoLink?: string | null;
  phone?: string | null;
}

function minutesOfDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = DateTime.fromISO(iso).setZone(OWNER_TIMEZONE);
  return t.isValid ? t.hour * 60 + t.minute : null;
}

// Edit a recurring schedule (title, cadence, time-of-day, where). Resyncs the
// change onto future occurrences already on the calendar.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: Parameters<typeof updateRecurringActionable>[1] = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.rrule !== undefined) patch.rrule = body.rrule;
  // A time edit sends both start and end (or both null to clear it). Only touch
  // the time when the request actually carries the fields.
  if (body.startTime !== undefined || body.endTime !== undefined) {
    patch.startMinutes = minutesOfDay(body.startTime);
    patch.endMinutes = minutesOfDay(body.endTime);
  }
  if (body.location !== undefined) patch.location = body.location;
  if (body.videoLink !== undefined) patch.videoLink = body.videoLink;
  if (body.phone !== undefined) patch.phone = body.phone;

  const result = await updateRecurringActionable(id, patch);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error, message: result.message }, { status });
  }
  return NextResponse.json({
    recurring: { id: result.template.id, title: result.template.title },
    nextOccurrence: result.nextOccurrence,
    resynced: result.resynced,
  });
}

// Cancel a recurring actionable: stop it seeding any more days. Soft — flips
// `active` to false so the row (and the link on already-seeded to-dos) survives
// and it could be resumed. Actionables it already created are left in place.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const existing = await prisma.recurringTodo.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "not_found", message: "No recurring actionable with that id." }, { status: 404 });
  }
  await prisma.recurringTodo.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true, cancelled: existing.title });
}
