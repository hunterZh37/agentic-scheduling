import { prisma } from "@/lib/db";
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
export async function actionableBusy(start: Date, end: Date): Promise<Interval[]> {
  const rows = await prisma.todo.findMany({
    // Overlap, not containment: an actionable that starts before the window and
    // runs into it still occupies the beginning of that window.
    where: { startTime: { not: null, lt: end }, endTime: { not: null, gt: start } },
    select: { startTime: true, endTime: true },
  });
  const out: Interval[] = [];
  for (const r of rows) {
    if (r.startTime && r.endTime) out.push({ start: r.startTime, end: r.endTime });
  }
  return out;
}
