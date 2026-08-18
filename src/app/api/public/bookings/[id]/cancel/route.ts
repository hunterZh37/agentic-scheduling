import { NextRequest, NextResponse } from "next/server";
import { cancelBooking, BookingError } from "@/lib/booking/service";
import { verifyManageToken } from "@/lib/booking/manageToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, but authorized by the per-booking manage token (?t=...) — the same
// unforgeable signature embedded in the invite's manage link. Lets an attendee
// cancel their own booking without any account.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const token = new URL(req.url).searchParams.get("t");
  if (!(await verifyManageToken(id, token))) {
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  }
  try {
    // notifyHost: alert the owner over WhatsApp since the attendee self-cancelled.
    const booking = await cancelBooking(id, { notifyHost: true });
    return NextResponse.json({ ok: true, status: booking.status });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.code === "booking_not_found" ? 404 : 409 }
      );
    }
    return NextResponse.json(
      { error: "cancel_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
