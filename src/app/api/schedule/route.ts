import { NextRequest, NextResponse } from "next/server";
import { getScheduleView } from "@/lib/schedule/service";
import { parseRange } from "@/lib/validation";

export const runtime = "nodejs";

// PRIVATE full-detail merged calendar view (events + blocks + bookings).
// Private-interface auth arrives in phase 7; do not expose publicly.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const range = parseRange(new URL(req.url));
  if ("error" in range) {
    return NextResponse.json({ error: "invalid_range", message: range.error }, { status: 400 });
  }

  const view = await getScheduleView(range.start, range.end);
  return NextResponse.json({
    events: view.events.map((e) => ({
      ...e,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
    })),
    blocks: view.blocks.map((b) => ({
      ...b,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
    })),
    bookings: view.bookings.map((b) => ({
      ...b,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
    })),
    birthdays: view.birthdays.map((b) => ({
      id: b.id,
      name: b.name,
      date: b.date.toISOString(),
      age: b.age,
    })),
    actionables: (view.actionables ?? []).map((a) => ({
      ...a,
      start: a.start.toISOString(),
      end: a.end.toISOString(),
    })),
    warnings: view.warnings,
  });
}
