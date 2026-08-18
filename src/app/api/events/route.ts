import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createDestinationEvent } from "@/lib/calendar/write";
import { parseIsoDate, isValidTimezone } from "@/lib/validation";

export const runtime = "nodejs";

// POST: create a real calendar event on the destination account. Mirrors the
// private agent's create_event tool (see src/lib/agent/tools.ts
// createEventTool()) — same lookup, same write helper, same error shapes —
// so the Blocks pane's "Event" add-card type produces an identical result to
// asking the agent to schedule something.

interface EventBody {
  /// Create a real video-call link (Meet/Teams). Defaults to true.
  addVideoLink?: boolean;
  title?: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  location?: string;
  /// iCal RRULE body for a recurring event (e.g. "FREQ=WEEKLY;BYDAY=SU").
  /// Requires `timezone`; omit both for a one-off.
  recurrenceRule?: string;
  timezone?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: EventBody;
  try {
    body = (await req.json()) as EventBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = body.title?.trim();
  const start = parseIsoDate(body.startTime);
  const end = parseIsoDate(body.endTime);
  if (!title || !start || !end) {
    return NextResponse.json(
      { error: "missing_params", message: "title, startTime, endTime (ISO 8601) are required." },
      { status: 400 }
    );
  }
  if (end <= start) {
    return NextResponse.json(
      { error: "invalid_range", message: "endTime must be after startTime." },
      { status: 400 }
    );
  }

  const recurrenceRule = body.recurrenceRule?.trim() || undefined;
  const timezone = body.timezone?.trim() || undefined;
  if (recurrenceRule && !timezone) {
    return NextResponse.json(
      { error: "timezone_required", message: "A recurring event needs a timezone." },
      { status: 400 }
    );
  }
  if (timezone && !isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "invalid_timezone", message: `Unknown IANA timezone: ${timezone}.` },
      { status: 400 }
    );
  }

  const destination = await prisma.account.findFirst({ where: { isDestination: true } });
  if (!destination) {
    return NextResponse.json(
      { error: "no_destination", message: "No destination account is configured." },
      { status: 503 }
    );
  }
  if (!destination.refreshToken && !destination.accessToken) {
    return NextResponse.json(
      {
        error: "destination_not_connected",
        message: `Destination account ${destination.email} is not connected. Authorize it before creating events.`,
      },
      { status: 503 }
    );
  }

  try {
    const created = await createDestinationEvent(destination, {
      title,
      start,
      end,
      description: body.description?.trim() || undefined,
      location: body.location?.trim() || undefined,
      recurrenceRule,
      timezone,
      // Default ON: an event with people on it needs a way to join. Pass
      // addVideoLink:false for a solo hold that doesn't want a room.
      conference: body.addVideoLink !== false,
    });
    return NextResponse.json(
      {
        ok: true,
        eventId: created.id,
        videoLink: created.videoLink ?? null,
        start: start.toISOString(),
        end: end.toISOString(),
      },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: "event_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
