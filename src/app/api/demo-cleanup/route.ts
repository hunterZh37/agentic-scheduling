import { NextResponse } from "next/server";
import { cleanupDemoBookings } from "@/lib/agent/demoBooking";

export const runtime = "nodejs";

// Delete (cancel) all demo bookings. This path ("/api/demo-cleanup") does not
// start with any PUBLIC_PREFIXES entry, so the proxy returns a 401 for
// unauthenticated /api/ calls, meaning only the owner can run this.
export async function POST(): Promise<NextResponse> {
  const { deleted } = await cleanupDemoBookings();
  return NextResponse.json({ deleted });
}
