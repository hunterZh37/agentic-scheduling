import { NextRequest, NextResponse } from "next/server";
import { getAvailability } from "@/lib/availability/service";
import { parseDurationMinutes } from "@/lib/validation";

export const runtime = "nodejs";

// Public-safe: returns ONLY free slots (UTC), never event titles/attendees or
// any calendar content. Consumed by the public booking page, the public agent,
// and the private interface alike.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const durationParam = url.searchParams.get("duration");

  if (!startParam || !endParam) {
    return NextResponse.json(
      { error: "missing_params", message: "start and end (ISO 8601) are required." },
      { status: 400 }
    );
  }
  const requestedStart = new Date(startParam);
  const requestedEnd = new Date(endParam);
  if (isNaN(requestedStart.getTime()) || isNaN(requestedEnd.getTime())) {
    return NextResponse.json(
      { error: "invalid_params", message: "start and end must be valid ISO 8601 timestamps." },
      { status: 400 }
    );
  }
  if (requestedEnd <= requestedStart) {
    return NextResponse.json(
      { error: "invalid_range", message: "end must be after start." },
      { status: 400 }
    );
  }

  const parsedDuration = parseDurationMinutes(durationParam);
  if ("error" in parsedDuration) {
    return NextResponse.json(
      { error: "invalid_duration", message: parsedDuration.error },
      { status: 400 }
    );
  }
  const durationMinutes = parsedDuration.minutes;

  const { slots, warnings } = await getAvailability({
    requestedStart,
    requestedEnd,
    durationMinutes,
  });

  // Public-safe: never leak connected-account emails or raw provider/internal
  // error strings to unauthenticated callers. Only signal that some source
  // couldn't be fully verified, with a generic, non-identifying code.
  return NextResponse.json({
    slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    partial: warnings.length > 0,
    warnings: warnings.map(() => ({ code: "account_unavailable" })),
  });
}
