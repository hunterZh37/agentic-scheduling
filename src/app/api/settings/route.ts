import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Owner-only booking rules. Behind the proxy owner gate. The Settings row is a
// singleton (id "singleton"); GET returns the effective values (defaults when no
// row exists yet), PATCH upserts just the fields sent.

const DEFAULTS = {
  bookingHorizonDays: 60,
  minNoticeHours: 0,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
};

export async function GET(): Promise<NextResponse> {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return NextResponse.json({
    settings: {
      bookingHorizonDays: row?.bookingHorizonDays ?? DEFAULTS.bookingHorizonDays,
      minNoticeHours: row?.minNoticeHours ?? DEFAULTS.minNoticeHours,
      bufferMinutes: row?.bufferMinutes ?? DEFAULTS.bufferMinutes,
      defaultEventDurationMinutes:
        row?.defaultEventDurationMinutes ?? DEFAULTS.defaultEventDurationMinutes,
    },
  });
}

// Bounds: notice/buffer can be zero (no restriction); horizon and duration must
// be positive or the booking page would offer nothing / zero-length meetings.
const BOUNDS = {
  bookingHorizonDays: { min: 1, max: 365 },
  minNoticeHours: { min: 0, max: 8760 },
  bufferMinutes: { min: 0, max: 240 },
  defaultEventDurationMinutes: { min: 5, max: 1440 },
} as const;

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const data: Record<string, number> = {};
  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < BOUNDS[key].min || v > BOUNDS[key].max) {
      return NextResponse.json({ error: "invalid_value", field: key }, { status: 400 });
    }
    data[key] = v;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const row = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...DEFAULTS, ...data },
  });
  return NextResponse.json({
    settings: {
      bookingHorizonDays: row.bookingHorizonDays,
      minNoticeHours: row.minNoticeHours,
      bufferMinutes: row.bufferMinutes,
      defaultEventDurationMinutes: row.defaultEventDurationMinutes,
    },
  });
}
