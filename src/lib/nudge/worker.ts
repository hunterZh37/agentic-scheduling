import { prisma } from "@/lib/db";
import { getScheduleView } from "@/lib/schedule/service";
import { alertHost } from "@/lib/booking/service";
import { nextOccurrence } from "./recurrence";
import { renderNudge, type ResolvedEvent } from "./render";

const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NudgeRow {
  id: string;
  body: string;
  fireAt: Date;
  timezone: string;
  recurrenceRule: string | null;
  eventKind: string | null;
  eventId: string | null;
  eventAccount: string | null;
  eventDate: Date | null;
  attempts: number;
}

export interface NudgeDeps {
  send?: (text: string, templateVar: string) => Promise<void>;
  resolveEvent?: (n: NudgeRow) => Promise<ResolvedEvent | null>;
  now?: Date;
  limit?: number;
}

export interface NudgeResult {
  processed: number;
  sent: number;
  failed: number;
  rearmed: number;
  deadLettered: number;
  errors: Array<{ nudgeId: string; message: string }>;
}

/// Resolve a linked event by re-reading the schedule for its day. Any failure
/// (schedule error, event deleted) returns null so the nudge falls back to its
/// snapshot body rather than failing.
async function defaultResolveEvent(n: NudgeRow): Promise<ResolvedEvent | null> {
  if (!n.eventKind || !n.eventId || !n.eventDate) return null;
  const dayStart = new Date(n.eventDate);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  try {
    const view = await getScheduleView(dayStart, dayEnd);
    if (n.eventKind === "event") {
      const e = view.events.find(
        (ev) => ev.id === n.eventId && (!n.eventAccount || ev.accountEmail === n.eventAccount)
      );
      return e ? { title: e.title, start: e.start } : null;
    }
    if (n.eventKind === "booking") {
      const b = view.bookings.find((bk) => bk.id === n.eventId);
      return b ? { title: b.title, start: b.start } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/// Grab due nudges and dispatch them. Each row is atomically claimed before
/// sending (overlapping runs can't double-send). Recurring nudges re-arm to the
/// next occurrence; one-offs stay sent; poison rows dead-letter after
/// MAX_ATTEMPTS. Mirrors processDueReminders.
export async function processDueNudges(deps: NudgeDeps = {}): Promise<NudgeResult> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? alertHost;
  const resolveEvent = deps.resolveEvent ?? defaultResolveEvent;
  const limit = deps.limit ?? 100;

  const due = await prisma.nudge.findMany({
    where: { sentAt: null, failedAt: null, fireAt: { lte: now } },
    orderBy: { fireAt: "asc" },
    take: limit,
  });

  const result: NudgeResult = { processed: due.length, sent: 0, failed: 0, rearmed: 0, deadLettered: 0, errors: [] };

  for (const n of due as NudgeRow[]) {
    // Outer guard: a DB error on the claim or a finalize update (e.g. the row was
    // cancelled/deleted mid-send → P2025) must not abort the whole batch, nor
    // escape and — via the cron's allSettled — it must never touch the reminders
    // worker's result.
    try {
      // Atomically claim (mark sent + bump attempts) so a concurrent run can't re-send.
      const claim = await prisma.nudge.updateMany({
        where: { id: n.id, sentAt: null, failedAt: null },
        data: { sentAt: now, attempts: { increment: 1 } },
      });
      if (claim.count === 0) continue;
      const attempts = n.attempts + 1;

      try {
        const resolved = await resolveEvent(n);
        const text = renderNudge(n, resolved, n.timezone);
        await send(text, text);

        // Re-arm recurring; one-off stays sent (the claim already set sentAt).
        const next = nextOccurrence(n.fireAt, n.recurrenceRule, n.timezone, now);
        if (next) {
          await prisma.nudge.update({ where: { id: n.id }, data: { fireAt: next, sentAt: null, attempts: 0 } });
          result.rearmed++;
        }
        result.sent++;
      } catch (err) {
        result.failed++;
        result.errors.push({ nudgeId: n.id, message: err instanceof Error ? err.message : String(err) });
        if (attempts >= MAX_ATTEMPTS) {
          await prisma.nudge.update({ where: { id: n.id }, data: { sentAt: null, failedAt: now } });
          result.deadLettered++;
        } else {
          await prisma.nudge.update({ where: { id: n.id }, data: { sentAt: null } });
        }
      }
    } catch (loopErr) {
      result.errors.push({ nudgeId: n.id, message: loopErr instanceof Error ? loopErr.message : String(loopErr) });
    }
  }

  return result;
}
