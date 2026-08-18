import { DateTime } from "luxon";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export interface CreateNudgeInput {
  fireAtISO: string;
  message: string;
  recurrenceRule?: string | null;
  event?: { kind: "event" | "booking" | "todo" | "followup"; id: string; account?: string | null } | null;
  eventDateISO?: string | null;
}

function whenLabel(fireAt: Date): string {
  return DateTime.fromJSDate(fireAt, { zone: "utc" }).setZone(OWNER_TIMEZONE).toFormat("EEE MMM d, h:mm a");
}

/// Create a nudge. Rejects an invalid or past fire time.
export async function createNudge(
  input: CreateNudgeInput,
  now: Date = new Date()
): Promise<{ ok: true; id: string; whenLabel: string; duplicate?: boolean } | { ok: false; error: string }> {
  const fireAt = new Date(input.fireAtISO);
  if (isNaN(fireAt.getTime())) return { ok: false, error: "invalid_fire_time" };
  if (fireAt.getTime() <= now.getTime()) return { ok: false, error: "fire_time_in_past" };
  const body = input.message.trim();
  if (!body) return { ok: false, error: "empty_message" };

  const eventKind = input.event?.kind ?? null;
  const eventId = input.event?.id ?? null;

  // Don't create a second reminder for the same item at the same time. Reminders
  // render at minute precision (whenLabel), so two that fall in the same minute
  // are visual duplicates — reuse the existing one instead. Scoped to the same
  // item (eventKind/eventId) so unrelated items sharing a minute don't collide.
  const minuteStart = new Date(Math.floor(fireAt.getTime() / 60_000) * 60_000);
  const minuteEnd = new Date(minuteStart.getTime() + 60_000);
  const dup = await prisma.nudge.findFirst({
    where: {
      sentAt: null,
      failedAt: null,
      eventKind,
      eventId,
      fireAt: { gte: minuteStart, lt: minuteEnd },
    },
  });
  if (dup) return { ok: true, id: dup.id, whenLabel: whenLabel(dup.fireAt), duplicate: true };

  const eventDate = input.eventDateISO ? new Date(input.eventDateISO) : null;

  const nudge = await prisma.nudge.create({
    data: {
      body,
      fireAt,
      timezone: OWNER_TIMEZONE,
      recurrenceRule: input.recurrenceRule?.trim() || null,
      eventKind,
      eventId,
      eventAccount: input.event?.account ?? null,
      eventDate: eventDate && !isNaN(eventDate.getTime()) ? eventDate : null,
    },
  });
  return { ok: true, id: nudge.id, whenLabel: whenLabel(fireAt) };
}

/// Upcoming (unsent, not dead-lettered) nudges, soonest first.
export async function listUpcomingNudges(): Promise<
  Array<{ id: string; whenLabel: string; body: string; recurring: boolean; eventKind: string | null; eventId: string | null }>
> {
  const rows = await prisma.nudge.findMany({
    where: { sentAt: null, failedAt: null },
    orderBy: { fireAt: "asc" },
  });
  return rows.map((n) => ({
    id: n.id,
    whenLabel: whenLabel(n.fireAt),
    body: n.body,
    recurring: n.recurrenceRule != null,
    eventKind: n.eventKind,
    eventId: n.eventId,
  }));
}

/// Delete a nudge. ok:false if it doesn't exist.
export async function cancelNudge(id: string): Promise<{ ok: boolean }> {
  try {
    await prisma.nudge.delete({ where: { id } });
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return { ok: false };
    throw err;
  }
}
