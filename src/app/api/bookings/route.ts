import { NextRequest, NextResponse } from "next/server";
import { BookingStatus, CreatedVia } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createBooking, BookingError } from "@/lib/booking/service";

export const runtime = "nodejs";

// GET: list bookings for the management / reminder-queue view. Defaults to
// upcoming confirmed bookings with their scheduled reminders.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const includePast = url.searchParams.get("includePast") === "true";
  const status = url.searchParams.get("status") as BookingStatus | null;

  const bookings = await prisma.booking.findMany({
    where: {
      ...(includePast ? {} : { endTime: { gte: new Date() } }),
      ...(status ? { status } : {}),
    },
    include: { reminders: { orderBy: { fireAt: "asc" } } },
    orderBy: { startTime: "asc" },
  });
  return NextResponse.json({ bookings });
}

// NOTE: This is the general booking endpoint. Private-interface auth arrives in
// phase 7; the fenced PUBLIC booking route (create_public_booking, rate-limited,
// scoped) is built alongside the public agent. Do not expose this one publicly.

interface BookingBody {
  title?: string;
  start?: string;
  end?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeeTimezone?: string;
  createdVia?: CreatedVia;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: BookingBody;
  try {
    body = (await req.json()) as BookingBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { title, start, end, attendeeName, attendeeEmail, attendeeTimezone } = body;
  if (!start || !end || !attendeeName || !attendeeEmail || !attendeeTimezone) {
    return NextResponse.json(
      {
        error: "missing_params",
        message: "start, end, attendeeName, attendeeEmail, attendeeTimezone are required.",
      },
      { status: 400 }
    );
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    return NextResponse.json(
      { error: "invalid_range", message: "start/end must be valid ISO 8601 with end after start." },
      { status: 400 }
    );
  }
  if (!isEmail(attendeeEmail)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  try {
    const booking = await createBooking({
      title,
      start: startDate,
      end: endDate,
      attendeeName,
      attendeeEmail,
      attendeeTimezone,
      createdVia: body.createdVia ?? CreatedVia.private_agent,
    });
    return NextResponse.json({ booking }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingError) {
      const status =
        err.code === "no_destination" || err.code === "destination_not_connected" ? 503 : 409;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { error: "booking_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
