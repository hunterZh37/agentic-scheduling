import { NextRequest, NextResponse } from "next/server";
import { CreatedVia } from "@prisma/client";
import { createBooking, BookingError } from "@/lib/booking/service";
import { canBook, recordBooking } from "@/lib/agent/rateLimit";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

export const runtime = "nodejs";

// Public slot-pick booking (createdVia = public_link). Rate-limited to one
// booking per visitor window, same guard the public agent uses. createBooking
// re-validates the slot against live busy + notice/horizon rules.
interface Body {
  start?: string;
  end?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeeTimezone?: string;
  note?: string;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // A JSON body of `null` (or a bare string/number) parses fine but is not an
  // object, so destructuring it threw and surfaced as an unauthenticated 500.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { start, end, attendeeName, attendeeEmail, attendeeTimezone } = body;
  // Presence alone isn't enough: a non-string field (e.g. attendeeName: 123)
  // passed this check and then blew up on .trim() as a 500 that leaked the
  // internal message ("o.trim is not a function") to anonymous callers.
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
  // Bound visitor-supplied text. These strings end up in the owner's calendar
  // event, the alert messages, and later in the private agent's get_schedule
  // tool results — unbounded anonymous input there is both a template-breaker
  // and an indirect prompt-injection amplifier. No human name or note needs
  // more than this.
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
    const title = `${attendeeName.trim()} <> ${OWNER_FIRST_NAME}`;
    const booking = await createBooking({
      title: body.note ? `${title} — ${body.note.trim()}` : title,
      start: startDate,
      end: endDate,
      attendeeName: attendeeName.trim(),
      attendeeEmail: attendeeEmail.trim(),
      attendeeTimezone,
      createdVia: CreatedVia.public_link,
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
      // 503 for transient/config server conditions (retryable), 409 for a real
      // slot conflict the visitor must resolve by picking another time.
      const status =
        err.code === "no_destination" ||
        err.code === "destination_not_connected" ||
        err.code === "availability_unverified"
          ? 503
          : 409;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    // Log the real error server-side, but never echo it to an anonymous caller:
    // it leaked minified internals (e.g. "o.trim is not a function") that tell
    // an attacker about the code path they just reached.
    console.error("[booking] unexpected failure:", err);
    return NextResponse.json(
      { error: "booking_failed", message: "Could not complete the booking. Please try again." },
      { status: 500 }
    );
  }
}
