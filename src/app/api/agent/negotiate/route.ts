import { NextRequest, NextResponse } from "next/server";
import { parseNegotiateBody } from "@/lib/agent/negotiate";
import { computeMutualSlots } from "@/lib/agent/mutualSlots";
import { checkMessageAllowed } from "@/lib/agent/rateLimit";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export const runtime = "nodejs";
export const maxDuration = 60;

// Agent-to-agent scheduling: a requester's agent posts its own free windows and
// the meeting params; we intersect them with the owner's live availability and
// return the mutually-free bookable slots. Exposes only free slots (never event
// detail) — same posture as the public booking page. Unauthenticated, rate-
// limited. The requester's agent commits a chosen slot via POST /api/public/
// bookings (unchanged); that path re-validates the slot before writing.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const decision = checkMessageAllowed(`negotiate:${ip}`);
  if (!decision.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = parseNegotiateBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { durationMinutes, windowStart, windowEnd, requesterFree } = parsed.value;
  const { mutualSlots, warnings } = await computeMutualSlots({
    windowStart,
    windowEnd,
    durationMinutes,
    requesterFree,
  });

  return NextResponse.json({
    mutualSlots: mutualSlots.map((s) => ({
      startISO: s.start.toISOString(),
      endISO: s.end.toISOString(),
    })),
    hostTimezone: OWNER_TIMEZONE,
    partial: warnings.length > 0,
    warnings,
  });
}
