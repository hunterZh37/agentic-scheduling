import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";
import { expandBlocks, mergeIntervals } from "@/lib/availability/index";
import { actionableBusy } from "@/lib/availability/actionableBusy";
import { checkSlots } from "@/lib/availability/slotCheck";

export const runtime = "nodejs";

// Called cross-origin by the Calendly availability browser extension, so it
// needs permissive CORS. It returns only free/busy booleans (no event content)
// — the same class of information the public /api/availability already exposes.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface Body {
  /// Calendar day the slots fall on, ISO "YYYY-MM-DD".
  date?: string;
  /// IANA zone the slot labels are written in (the Calendly viewer's zone).
  timezone?: string;
  /// Meeting length in minutes.
  durationMinutes?: number;
  /// Wall-clock time labels as shown on Calendly, e.g. ["9:30pm", "11:00pm"].
  slots?: unknown;
}

/// Cross-check a set of local-time slots (scraped from someone else's Calendly
/// page) against the owner's aggregated free/busy — their connected calendar
/// accounts plus personal blocks. Returns free/busy per slot so the extension
/// can badge the ones that work.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Body | null;
  const slots = Array.isArray(body?.slots) ? body!.slots.map(String) : null;
  if (!body?.date || !body?.timezone || !slots) {
    return NextResponse.json(
      { error: "missing_params", message: "date, timezone, and slots[] are required." },
      { status: 400, headers: CORS }
    );
  }
  const duration = Number(body.durationMinutes) > 0 ? Number(body.durationMinutes) : 30;

  const dayStart = DateTime.fromISO(body.date, { zone: body.timezone }).startOf("day");
  if (!dayStart.isValid) {
    return NextResponse.json(
      { error: "invalid_date", message: "date/timezone did not resolve to a valid day." },
      { status: 400, headers: CORS }
    );
  }
  // Widen the window a little past midnight so a late-evening slot whose meeting
  // spills into the next day is still checked against that day's busy.
  const startUtc = dayStart.toUTC().toJSDate();
  const endUtc = dayStart.plus({ days: 1, hours: 2 }).toUTC().toJSDate();

  const [{ busy, errors }, blockRows, todoBusy] = await Promise.all([
    fanOutBusy(startUtc, endUtc),
    prisma.personalBlock.findMany(),
    actionableBusy(startUtc, endUtc),
  ]);
  const blockBusy = expandBlocks(
    blockRows.map((b) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      timezone: b.timezone,
      recurrenceRule: b.recurrenceRule,
    })),
    startUtc,
    endUtc
  );
  const allBusy = mergeIntervals([...busy, ...blockBusy, ...todoBusy]);

  const results = checkSlots({
    date: body.date,
    timezone: body.timezone,
    durationMinutes: duration,
    slots,
    busy: allBusy,
  });

  return NextResponse.json(
    { date: body.date, timezone: body.timezone, durationMinutes: duration, results, partial: errors.length > 0 },
    { headers: CORS }
  );
}
