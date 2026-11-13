import { BookingStatus, type Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listEvents, type CalendarEvent } from "@/lib/calendar/read";
import { CALENDAR_READ_TIMEOUT_MS, withDeadline } from "@/lib/calendar/deadline";
import { expandBlock } from "@/lib/availability/index";
import { birthdayOccurrencesInRange, type BirthdayOccurrence } from "@/lib/birthdays/birthdays";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export interface BlockOccurrence {
  id: string;
  title: string;
  start: Date;
  end: Date;
  /// Whether the underlying block is crossed off ("done"). Template-level, so
  /// every occurrence of a recurring block shares it.
  done: boolean;
}

export interface ScheduleBooking {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendeeName: string;
  attendeeEmail: string;
  attendeeTimezone: string;
  status: BookingStatus;
}

/// A timed actionable (Todo with a start/end) surfaced onto the calendar grid.
/// Untimed to-dos live only in the day's agenda, so they're not included here.
export interface ScheduleActionable {
  id: string;
  title: string;
  start: Date;
  end: Date;
  done: boolean;
  location: string | null;
  videoLink: string | null;
  phone: string | null;
}

export interface ScheduleView {
  events: CalendarEvent[];
  blocks: BlockOccurrence[];
  bookings: ScheduleBooking[];
  birthdays: BirthdayOccurrence[];
  /// Timed actionables (to-dos) placed on the calendar as their own kind.
  actionables?: ScheduleActionable[];
  /// Accounts whose events could not be loaded (not connected / API error).
  warnings: Array<{ email: string; message: string }>;
  /// Set only when events were skipped (`{ events: false }`): the visible
  /// owner calendars, so the dashboard can load each one on its own.
  accounts?: Array<{ id: string; email: string }>;
}

export { CALENDAR_READ_TIMEOUT_MS };

/// listEvents with a deadline: one slow calendar becomes a warning instead of
/// holding up the whole dashboard. See src/lib/calendar/deadline.ts.
function listEventsWithin(account: Account, start: Date, end: Date): Promise<CalendarEvent[]> {
  return withDeadline((signal) => listEvents(account, start, end, signal));
}

/// The merged private calendar view for [start, end): real calendar events
/// across all accounts, expanded personal-block occurrences, and bookings.
/// PRIVATE — includes titles/attendees. Degrades gracefully per account.
///
/// `{ events: false }` skips the provider reads and lists the visible accounts
/// instead. The dashboard then loads each calendar with getAccountEvents, so a
/// slow provider shows up last rather than holding everything (2026-11-12).
export async function getScheduleView(
  start: Date,
  end: Date,
  opts: { events?: boolean } = {}
): Promise<ScheduleView> {
  const [accounts, blockRows, bookingRows, todoRows, birthdayResult] = await Promise.all([
    // Owner accounts/blocks ONLY (coHostId=null). A co-host's connected calendars
    // and reserved blocks are theirs alone — they must never surface on the
    // owner's dashboard. This is the owner side of the co-host privacy wall, and
    // the same scoping the availability read already uses. See docs/REGRESSIONS.md.
    prisma.account.findMany({ where: { coHostId: null } }),
    prisma.personalBlock.findMany({ where: { visible: true, coHostId: null } }),
    prisma.booking.findMany({
      where: { status: BookingStatus.confirmed, startTime: { lt: end }, endTime: { gt: start } },
      orderBy: { startTime: "asc" },
    }),
    // Timed to-dos overlapping the window — placed on the grid as actionables.
    // (Untimed to-dos have no time, so they stay in the day agenda only.)
    prisma.todo.findMany({
      where: { startTime: { not: null, lt: end }, endTime: { gt: start } },
      orderBy: { startTime: "asc" },
    }),
    // Birthdays are an optional feature; a failure here (e.g. the table missing
    // before its migration is applied) must NOT take down the whole calendar.
    // Settle it to a tagged result so it degrades to a warning, like accounts.
    prisma.birthday
      .findMany()
      .then((rows) => ({ ok: true as const, rows }))
      .catch((err: unknown) => ({ ok: false as const, err })),
  ]);

  // Only pull events for accounts the user has left visible in the Calendars
  // manager. Color stays each account's stable identity.
  const visibleAccounts = accounts.filter((a) => a.visible);
  const withEvents = opts.events !== false;
  const settled = withEvents
    ? await Promise.allSettled(visibleAccounts.map((a) => listEventsWithin(a, start, end)))
    : [];
  // A booking writes an event to the destination calendar, which then syncs back
  // via listEvents — so the same meeting would appear twice (once as a booking,
  // once as its provider event). Drop the synced provider events that belong to a
  // booking; the booking row is the canonical entry (it carries attendee + manage).
  const bookingEventIds = new Set(
    bookingRows.map((b) => b.externalEventId).filter((id): id is string => !!id)
  );
  const events: CalendarEvent[] = [];
  const warnings: ScheduleView["warnings"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") events.push(...r.value.filter((e) => !bookingEventIds.has(e.id)));
    else
      warnings.push({
        email: visibleAccounts[i].email,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
  });

  const blocks: BlockOccurrence[] = blockRows.flatMap((b) =>
    expandBlock(
      { startTime: b.startTime, endTime: b.endTime, timezone: b.timezone, recurrenceRule: b.recurrenceRule },
      start,
      end
    ).map((iv) => ({ id: b.id, title: b.title, start: iv.start, end: iv.end, done: b.done }))
  );

  const bookings: ScheduleBooking[] = bookingRows.map((b) => ({
    id: b.id,
    title: b.title,
    start: b.startTime,
    end: b.endTime,
    attendeeName: b.attendeeName,
    attendeeEmail: b.attendeeEmail,
    attendeeTimezone: b.attendeeTimezone,
    status: b.status,
  }));

  const actionables: ScheduleActionable[] = todoRows
    .filter((t) => t.startTime && t.endTime)
    .map((t) => ({
      id: t.id,
      title: t.title,
      start: t.startTime!,
      end: t.endTime!,
      done: t.done,
      location: t.location,
      videoLink: t.videoLink,
      phone: t.phone,
    }));

  let birthdays: BirthdayOccurrence[] = [];
  if (birthdayResult.ok) {
    birthdays = birthdayOccurrencesInRange(birthdayResult.rows, start, end, OWNER_TIMEZONE);
  } else {
    warnings.push({
      email: "birthdays",
      message: birthdayResult.err instanceof Error ? birthdayResult.err.message : String(birthdayResult.err),
    });
  }

  return {
    events,
    blocks,
    bookings,
    birthdays,
    actionables,
    warnings,
    ...(withEvents ? {} : { accounts: visibleAccounts.map((a) => ({ id: a.id, email: a.email })) }),
  };
}

export type AccountEventsResult =
  | { ok: true; email: string; events: CalendarEvent[] }
  | { ok: false; email: string; message: string };

/// One owner calendar's events for [start, end), with the same deadline and
/// booking de-duplication as getScheduleView. Returns null for an id that is
/// not a visible OWNER account: a co-host's calendar must never be readable
/// from the owner's dashboard (the co-host privacy wall, docs/REGRESSIONS.md).
export async function getAccountEvents(
  accountId: string,
  start: Date,
  end: Date
): Promise<AccountEventsResult | null> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, coHostId: null, visible: true },
  });
  if (!account) return null;
  const [bookingRows, read] = await Promise.all([
    prisma.booking.findMany({
      where: { status: BookingStatus.confirmed, startTime: { lt: end }, endTime: { gt: start } },
      select: { externalEventId: true },
    }),
    listEventsWithin(account, start, end).then(
      (events) => ({ ok: true as const, events }),
      (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) })
    ),
  ]);
  if (!read.ok) return { ok: false, email: account.email, message: read.message };
  const bookingEventIds = new Set(bookingRows.map((b) => b.externalEventId).filter((id): id is string => !!id));
  return { ok: true, email: account.email, events: read.events.filter((e) => !bookingEventIds.has(e.id)) };
}
