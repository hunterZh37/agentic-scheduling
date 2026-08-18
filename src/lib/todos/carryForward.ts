import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

/// The subset of a Todo the carry-forward needs. Kept structural so the pure
/// helpers can be tested without a database.
export interface CarrySource {
  id: string;
  title: string;
  startTime: Date | null;
  endTime: Date | null;
  location: string | null;
  videoLink: string | null;
  phone: string | null;
}

/// The `date` day-key for a luxon day: a UTC instant equal to owner-timezone
/// local midnight. Matches exactly how the client stores Todo.date, so an
/// equality query on `date` finds that day's rows.
export function dayKey(day: DateTime): Date {
  return day.setZone(OWNER_TIMEZONE).startOf("day").toUTC().toJSDate();
}

/// Move an instant to the SAME local time-of-day on `targetDay`, in the owner's
/// timezone. DST-safe on purpose: it rebuilds the time on the new date rather
/// than adding 24h, so a 9:00 AM task stays 9:00 AM even across a clock change.
export function shiftToDay(instant: Date, targetDay: DateTime): Date {
  const src = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(OWNER_TIMEZONE);
  return targetDay
    .setZone(OWNER_TIMEZONE)
    .set({ hour: src.hour, minute: src.minute, second: src.second, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/// The row data for the carried copy of `source` onto `targetDay`. Pure — no DB.
/// `rolledFromId` links back to the source and is the idempotency key.
export function carriedTodoData(source: CarrySource, targetDay: DateTime, sortOrder: number) {
  return {
    title: source.title,
    date: dayKey(targetDay),
    startTime: source.startTime ? shiftToDay(source.startTime, targetDay) : null,
    endTime: source.endTime ? shiftToDay(source.endTime, targetDay) : null,
    location: source.location,
    videoLink: source.videoLink,
    phone: source.phone,
    sortOrder,
    rolledFromId: source.id,
  };
}

/// Duplicate YESTERDAY's unfinished actionables onto today, at the same
/// time-of-day. Only actionables — events, bookings and blocks are never
/// touched. Idempotent: a source already carried is skipped, and the unique
/// `rolledFromId` constraint rejects any concurrent double-create, so a re-run
/// (a cron retry, a double load) is a safe no-op.
export async function carryForwardTodos(
  now: DateTime = DateTime.now()
): Promise<{ created: number; considered: number }> {
  const today = now.setZone(OWNER_TIMEZONE).startOf("day");
  const yesterdayKey = dayKey(today.minus({ days: 1 }));

  const sources = await prisma.todo.findMany({
    where: { date: yesterdayKey, done: false },
    orderBy: { sortOrder: "asc" },
  });
  if (sources.length === 0) return { created: 0, considered: 0 };

  // Skip sources already carried — the common no-op path on a re-run, and it
  // avoids relying on caught unique-violations for the steady state.
  const existing = await prisma.todo.findMany({
    where: { rolledFromId: { in: sources.map((s) => s.id) } },
    select: { rolledFromId: true },
  });
  const carried = new Set(existing.map((c) => c.rolledFromId));
  const pending = sources.filter((s) => !carried.has(s.id));
  if (pending.length === 0) return { created: 0, considered: sources.length };

  // New copies land at the end of today's list, keeping their relative order.
  const last = await prisma.todo.findFirst({
    where: { date: dayKey(today) },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  let nextOrder = (last?.sortOrder ?? -1) + 1;

  let created = 0;
  for (const s of pending) {
    try {
      await prisma.todo.create({ data: carriedTodoData(s, today, nextOrder++) });
      created++;
    } catch (err) {
      // A concurrent run won the unique race — that copy already exists, so this
      // no-op is exactly the outcome we want.
      const code = (err as { code?: string })?.code;
      if (code !== "P2002") throw err;
    }
  }
  return { created, considered: sources.length };
}
