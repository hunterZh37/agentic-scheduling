import { NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { optionalEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { buildManageUrl, signManageToken } from "@/lib/booking/manageToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staging/e2e ONLY: returns the most recent confirmed booking + its signed
// manage URL, so the Playwright reschedule/cancel specs can reach the
// token-gated manage page (the token is normally only in the emailed link,
// which staging stubs). Hard-disabled unless E2E_STUB_CALENDAR is set, so it
// can never leak a manage token in production.
export async function GET(): Promise<NextResponse> {
  if (optionalEnv("E2E_STUB_CALENDAR") !== "true") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const booking = await prisma.booking.findFirst({
    where: { status: BookingStatus.confirmed },
    orderBy: { createdAt: "desc" },
  });
  if (!booking) return NextResponse.json({ error: "no_booking" }, { status: 404 });
  const manageUrl = buildManageUrl(booking.id, await signManageToken(booking.id));
  return NextResponse.json({ id: booking.id, title: booking.title, manageUrl });
}
