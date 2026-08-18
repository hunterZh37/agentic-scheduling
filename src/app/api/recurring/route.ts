import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import {
  describeRRule,
  nextOccurrence,
  materializeRecurringTodos,
  createRecurringActionable,
} from "@/lib/todos/recurring";

export const runtime = "nodejs";

// The owner's active recurring actionables (the schedules that seed repeating
// to-dos). Read-only list for the dashboard's "Recurring" section, so a series
// is visible the moment it's set up — not only on its first due day. Cancel is
// DELETE /api/recurring/[id].

export async function GET(): Promise<NextResponse> {
  // Ensure each active series' upcoming occurrence is materialized before we
  // list. Idempotent (guarded by @@unique) and owner-only, so it's a safe
  // side-effect on read — and it self-heals a series created before the eager
  // seeding shipped (or a day the daily cron missed): opening the dashboard puts
  // the next actionable on its due day without waiting for the 7 AM run.
  try {
    await materializeRecurringTodos();
  } catch (err) {
    console.error("[recurring] materialize on list failed:", err);
  }

  const templates = await prisma.recurringTodo.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  const recurring = templates.map((t) => {
    const anchor = DateTime.fromJSDate(t.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
    const next = nextOccurrence(t.rrule, anchor);
    return {
      id: t.id,
      title: t.title,
      cadence: describeRRule(t.rrule),
      nextOccurrence: next ? next.toISODate() : null,
      timed: t.startMinutes != null,
      // Extra fields the detail/edit panel needs (the list carries enough to open
      // the editor without a second fetch).
      rrule: t.rrule,
      startMinutes: t.startMinutes,
      endMinutes: t.endMinutes,
      location: t.location,
      videoLink: t.videoLink,
      phone: t.phone,
    };
  });
  return NextResponse.json({ recurring });
}

interface RecurringBody {
  title?: string;
  rrule?: string;
  // Optional TIMED occurrence: representative ISO instants whose owner-local
  // time-of-day repeats each due day. Both or neither.
  startTime?: string;
  endTime?: string;
  location?: string;
  videoLink?: string;
  phone?: string;
}

// Minutes past owner-local midnight for an ISO instant, or null if absent/invalid.
function minutesOfDay(iso?: string): number | null {
  if (!iso) return null;
  const t = DateTime.fromISO(iso).setZone(OWNER_TIMEZONE);
  return t.isValid ? t.hour * 60 + t.minute : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: RecurringBody;
  try {
    body = (await req.json()) as RecurringBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const timed = body.startTime !== undefined && body.endTime !== undefined;
  const result = await createRecurringActionable({
    title: body.title ?? "",
    rrule: body.rrule ?? "",
    startMinutes: timed ? minutesOfDay(body.startTime) : null,
    endMinutes: timed ? minutesOfDay(body.endTime) : null,
    location: body.location ?? null,
    videoLink: body.videoLink ?? null,
    phone: body.phone ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: 400 });
  }
  return NextResponse.json(
    { recurring: { id: result.template.id, title: result.template.title }, seeded: result.seeded, nextOccurrence: result.nextOccurrence },
    { status: 201 }
  );
}
