import { NextRequest, NextResponse } from "next/server";
import { rescheduleBooking, BookingError } from "@/lib/booking/service";
import { verifyManageToken } from "@/lib/booking/manageToken";
import { checkRescheduleAllowed } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  token?: string;
  start?: string;
  end?: string;
}

// Public, authorized by the per-booking manage token. Moves the booking to a
// new slot (books the new time with the same attendee, then cancels the old).
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  // Each reschedule performs a real calendar write and re-emails a manage
  // link, so it gets its own per-IP window — the manage token alone would let
  // a scripted attendee loop this forever.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRescheduleAllowed(ip).ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  const token = body?.token ?? new URL(req.url).searchParams.get("t");
  if (!(await verifyManageToken(id, token))) {
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  }
  if (!body?.start || !body?.end) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const start = new Date(body.start);
  const end = new Date(body.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  try {
    const booking = await rescheduleBooking(id, { start, end });
    return NextResponse.json(
      {
        ok: true,
        booking: {
          id: booking.id,
          start: booking.startTime.toISOString(),
          end: booking.endTime.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof BookingError) {
      const status =
        err.code === "booking_not_found"
          ? 404
          : err.code === "no_destination" ||
              err.code === "destination_not_connected" ||
              err.code === "availability_unverified"
            ? 503
            : 409;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { error: "reschedule_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
