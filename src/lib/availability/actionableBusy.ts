import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { dayKey } from "@/lib/todos/carryForward";
import { projectCarriedBusy, type CarryHead } from "./carryProjection";
import type { Interval } from "./interval";

/// Timed actionables as busy intervals.
///
/// Actionables are first-class items, deliberately NOT mirrored to a provider
/// calendar (mirroring made each one show up twice, as an ACTIONABLE and again
/// as an EVENT). The cost of that fix was that they stopped contributing busy
/// time entirely, so the booking page happily offered a slot the owner had
/// already committed — 4:30pm "Cleaning up" was on the agenda while /book
/// advertised 4:30pm as free.
///
/// Every busy computation must include these: the slot list the visitor sees,
/// the guard that accepts a booking, and the Calendly cross-check. Hiding the
/// slot without guarding the write would still let a direct API call through.
///
/// `done` is not filtered on. A commitment that is on the calendar blocks the
/// time whether or not it has been ticked off — being wrong toward "busy" costs
/// a slot, being wrong toward "free" costs a double-booking.
///
/// CARRIED-OVER time counts too. An unfinished timed actionable is copied to
/// the next day at the same time-of-day, every day until it is done — but the
/// copy only becomes a row on the day itself (7 AM Pacific cron), while visitors
/// book days ahead. So the slot it was about to occupy was offered as free, and
/// the cron then dropped the actionable on top of someone's booking. The busy
/// set therefore also includes where the live end of each carry chain WILL land
/// (see carryProjection.ts). Because every busy path calls this one function,
/// the slot list and the write guard cannot disagree about it.
export async function actionableBusy(
  start: Date,
  end: Date,
  now: Date = new Date()
): Promise<Interval[]> {
  const today = DateTime.fromJSDate(now).setZone(OWNER_TIMEZONE).startOf("day");
  const [rows, candidates] = await Promise.all([
    prisma.todo.findMany({
      // Overlap, not containment: an actionable that starts before the window and
      // runs into it still occupies the beginning of that window.
      where: { startTime: { not: null, lt: end }, endTime: { not: null, gt: start } },
      select: { startTime: true, endTime: true },
    }),
    // Carry candidates: unfinished + timed, on today or yesterday. Yesterday
    // covers the hours between local midnight and the cron run. Nothing older:
    // the cron only ever carries "yesterday", so an older unfinished row is a
    // dead end, and projecting it would reserve time for a copy that never comes.
    // `done` IS filtered here, unlike above — a finished actionable stops carrying.
    prisma.todo.findMany({
      where: {
        done: false,
        startTime: { not: null },
        endTime: { not: null },
        date: { in: [dayKey(today), dayKey(today.minus({ days: 1 }))] },
      },
      select: { id: true, date: true, startTime: true, endTime: true },
    }),
  ]);

  const out: Interval[] = [];
  for (const r of rows) {
    if (r.startTime && r.endTime) out.push({ start: r.startTime, end: r.endTime });
  }

  if (candidates.length > 0) {
    // A candidate already carried is no longer the live end of its chain — its
    // copy is, and that copy is a candidate in its own right.
    const carried = await prisma.todo.findMany({
      where: { rolledFromId: { in: candidates.map((c) => c.id) } },
      select: { rolledFromId: true },
    });
    const carriedIds = new Set(carried.map((c) => c.rolledFromId));
    const heads: CarryHead[] = [];
    for (const c of candidates) {
      if (carriedIds.has(c.id) || !c.startTime || !c.endTime) continue;
      heads.push({ id: c.id, date: c.date, startTime: c.startTime, endTime: c.endTime });
    }
    out.push(...projectCarriedBusy(heads, start, end));
  }
  return out;
}
