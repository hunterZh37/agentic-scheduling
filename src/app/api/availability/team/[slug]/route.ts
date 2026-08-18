import { NextRequest, NextResponse } from "next/server";
import { getJointAvailability } from "@/lib/availability/jointService";
import { teamForSlug } from "@/lib/teams/resolve";
import { parseDurationMinutes } from "@/lib/validation";

export const runtime = "nodejs";

// Public-safe joint availability for a team slug: ONLY the slots where EVERY
// member (owner + the team's co-hosts) is free. Never leaks who the members are,
// their calendar content, or account emails — same contract as /api/availability.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const team = await teamForSlug(slug);
  if (!team) {
    return NextResponse.json({ error: "unknown_team" }, { status: 404 });
  }

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

  const { slots, warnings } = await getJointAvailability({
    coHostIds: team.coHostIds,
    requestedStart,
    requestedEnd,
    durationMinutes: parsedDuration.minutes,
  });

  return NextResponse.json({
    slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    partial: warnings.length > 0,
    warnings: warnings.map(() => ({ code: "account_unavailable" })),
  });
}
