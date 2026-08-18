import { NextRequest, NextResponse } from "next/server";
import { CreatedVia } from "@prisma/client";
import { createBooking, BookingError } from "@/lib/booking/service";
import { canBook, recordBooking } from "@/lib/agent/rateLimit";
import { teamForSlug, firstNamesLabel } from "@/lib/teams/resolve";
import { HOST } from "@/lib/booking/publicConfig";

export const runtime = "nodejs";

// Public JOINT booking: book a time on a team's shared link. Same validation and
// rate limiting as the single-owner /api/public/bookings, but resolves the team
// first and asks createBooking to (a) re-verify EVERY member is free and (b) put
// every co-host on the invite so the event lands on their calendars too.
interface Body {
  start?: string;
  end?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeeTimezone?: string;
  note?: string;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const team = await teamForSlug(slug);
  if (!team) {
    return NextResponse.json({ error: "unknown_team" }, { status: 404 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { start, end, attendeeName, attendeeEmail, attendeeTimezone } = body;
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof attendeeName !== "string" ||
    typeof attendeeEmail !== "string" ||
    typeof attendeeTimezone !== "string" ||
    !start || !end || !attendeeName.trim() || !attendeeEmail || !attendeeTimezone
  ) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
  }
  if (attendeeName.length > 120 || (body.note?.length ?? 0) > 1000) {
    return NextResponse.json({ error: "too_long" }, { status: 400 });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  if (!isEmail(attendeeEmail)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!canBook(ip)) {
    return NextResponse.json(
      { error: "booking_limit", message: "You've already booked a time recently." },
      { status: 429 }
    );
  }

  try {
    // Sign off from every host, co-hosts first, each with their LinkedIn.
    const hosts = [
      ...team.coHosts.map((c) => ({ name: c.name, linkedin: c.linkedin })),
      { name: HOST.name, linkedin: HOST.linkedin || null },
    ];
    // The event title and "meeting with …" name the PEOPLE (e.g. "Ben & Hunter"),
    // derived from the members — never the team's internal name (may be "Team").
    const label = firstNamesLabel(hosts.map((h) => h.name));
    const base = `${attendeeName.trim()} <> ${label}`;
    const booking = await createBooking({
      title: body.note ? `${base} — ${body.note.trim()}` : base,
      start: startDate,
      end: endDate,
      attendeeName: attendeeName.trim(),
      attendeeEmail: attendeeEmail.trim(),
      attendeeTimezone,
      createdVia: CreatedVia.public_link,
      coHostIds: team.coHostIds,
      additionalAttendeeEmails: team.coHosts.map((c) => c.email),
      teamId: team.id,
      hostLabel: label,
      hosts,
    });
    recordBooking(ip);
    return NextResponse.json(
      {
        booking: {
          id: booking.id,
          start: booking.startTime.toISOString(),
          end: booking.endTime.toISOString(),
          attendeeEmail: booking.attendeeEmail,
          attendeeTimezone: booking.attendeeTimezone,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof BookingError) {
      const status =
        err.code === "no_destination" ||
        err.code === "destination_not_connected" ||
        err.code === "availability_unverified"
          ? 503
          : 409;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error("[team booking] unexpected failure:", err);
    return NextResponse.json(
      { error: "booking_failed", message: "Could not complete the booking. Please try again." },
      { status: 500 }
    );
  }
}
