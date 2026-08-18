import { NextRequest, NextResponse } from "next/server";
import { cancelBooking, rescheduleBooking, BookingError } from "@/lib/booking/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reschedule a booking from the private dashboard: move its time (and optionally
// rename it). rescheduleBooking books the new slot, cancels the old one, and —
// because both are real calendar writes — the provider sends the attendee an
// updated invite for the new time and a cancellation for the old. Private:
// gated by the proxy like the rest of /api/bookings.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { start?: string; end?: string; title?: string }
    | null;
  if (!body?.start || !body?.end) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const start = new Date(body.start);
  const end = new Date(body.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  try {
    const booking = await rescheduleBooking(id, { start, end, title: body.title });
    return NextResponse.json({
      ok: true,
      id: booking.id,
      start: booking.startTime.toISOString(),
      end: booking.endTime.toISOString(),
    });
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

// Cancel a booking from the private dashboard. Removes the provider calendar
// event (emailing the attendee the cancellation) and marks the row cancelled —
// see cancelBooking. Private: gated by the proxy like the rest of /api/bookings.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const booking = await cancelBooking(id);
    return NextResponse.json({ ok: true, id: booking.id, status: booking.status });
  } catch (err) {
    if (err instanceof BookingError) {
      const status = err.code === "booking_not_found" ? 404 : 409;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { error: "cancel_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
