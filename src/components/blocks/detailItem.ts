import { DateTime } from "luxon";
import type { CalendarItem, ItemAttendee } from "@/components/calendar/types";
import { HOST } from "@/lib/booking/publicConfig";

/// Build the detail item for an UNTIMED actionable so its agenda row opens the
/// same editor as every other item. An untimed to-do has no start/end, but the
/// editor always shows a time, so we seed a default 30-minute slot at 9:00 AM
/// on the given day (its own selected day); the owner adjusts or keeps it.
/// Without this, untimed actionables were the one agenda row that could not be
/// clicked to edit (reported 2026-08-19).
export function untimedTodoDetailItem(
  t: { id: string; title: string; location?: string | null; videoLink?: string | null; phone?: string | null },
  day: DateTime
): CalendarItem {
  const start = day.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  const end = start.plus({ minutes: 30 });
  return {
    id: `actionable:${t.id}`,
    kind: "actionable",
    title: t.title,
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    location: t.location ?? undefined,
    videoLink: t.videoLink ?? undefined,
    phone: t.phone ?? undefined,
  };
}

/// A row of the "Upcoming bookings" section (from /api/bookings). Carries the
/// end time and attendee email so the row can open the same detail modal the
/// agenda and calendar grid use — not just render a summary line.
export interface BookingRow {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeeTimezone: string;
  status: string;
  /// Last write to the row. For a cancelled booking this is when it was
  /// cancelled — nothing touches the record afterwards — which is what the
  /// 24-hour auto-hide in the Upcoming list keys off. Optional so existing
  /// fixtures and the demo data stay valid.
  updatedAt?: string;
}

/// One entry in the merged agenda checklist: a calendar event, a reserved-block
/// occurrence, a booking, a birthday, or a TIMED to-do that happens on the
/// selected day.
export type AgendaItem = {
  key: string;
  kind: "event" | "block" | "booking" | "todo" | "birthday";
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  colorVar: string;
  attendeeName?: string;
  /// Booking-only: the attendee's address and the booking's own id, which the
  /// detail modal needs to identify and act on it.
  attendeeEmail?: string;
  bookingId?: string;
  // Event-only detail fields, carried through so a clicked event row can open
  // the full EventModal (mirrors CalendarItem's event-only fields). `location`
  // and `videoLink` are also reused (as "where" fields) by timed todos below.
  // `eventId` is the bare provider id (the row `key` also folds in the start);
  // the modal needs the bare id for its provider edit/delete + follow-up key.
  eventId?: string;
  accountEmail?: string;
  location?: string;
  description?: string;
  videoLink?: string;
  organizer?: { email: string; name?: string };
  attendees?: ItemAttendee[];
  reminders?: number[];
  htmlLink?: string;
  // Todo-only fields, so a merged-in timed todo row can still toggle/delete
  // through the same handlers as the untimed rows above it, and show its
  // "where" (location / videoLink / phone — see above for the first two).
  todoId?: string;
  done?: boolean;
  phone?: string;
  /// Todo-only: true when this actionable was carried forward from an
  /// unfinished one the previous day. Drives the small "carried over" marker.
  carriedOver?: boolean;
  /// Todo-only: true when this actionable was seeded by a recurring schedule.
  /// Drives the small "recurring" marker.
  recurring?: boolean;
  // Block-only: the underlying PersonalBlock id, so a block row can persist its
  // crossed-off ("done") state via PATCH instead of the local `checked` set.
  blockId?: string;
};

/// The EventModal item for an agenda row, or undefined for the one kind that
/// deliberately has no detail view (a birthday is a read-only marker). Every
/// other kind MUST map — a fall-through here is exactly the bug where a row
/// silently isn't clickable while the same item opens fine elsewhere
/// (regressions #28 and #29).
export function agendaDetailItem(item: AgendaItem): CalendarItem | undefined {
  switch (item.kind) {
    case "block":
      return {
        id: item.key,
        kind: "block",
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
      };
    case "event":
      return {
        // Bare provider-id form (matches the calendar grid's `event:<id>`), so
        // the modal's provider edit/delete and its follow-up key are correct.
        // The occurrence's start is added back by followupKey(item.id, item.start).
        id: `event:${item.eventId}`,
        kind: "event",
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
        accountEmail: item.accountEmail,
        location: item.location,
        description: item.description,
        videoLink: item.videoLink,
        organizer: item.organizer,
        attendees: item.attendees,
        reminders: item.reminders,
        htmlLink: item.htmlLink,
      };
    case "booking":
      return {
        id: `booking:${item.bookingId}`,
        kind: "booking",
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
        attendees: item.attendeeEmail
          ? [{ email: item.attendeeEmail, name: item.attendeeName }]
          : undefined,
        // Every booking meets in the owner's room, which is what the invite and
        // the confirmation email carry. The detail panel omitted it, so the one
        // place the owner looks before a call showed no way to join a meeting
        // the attendee had a link for.
        videoLink: HOST.videoLink || undefined,
      };
    case "todo":
      return {
        id: `actionable:${item.todoId}`,
        kind: "actionable",
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
        location: item.location,
        videoLink: item.videoLink,
        phone: item.phone,
      };
    case "birthday":
      return undefined;
  }
}

/// The EventModal item for an "Upcoming bookings" row. Same shape the agenda's
/// booking rows (and the calendar grid) produce, so all three surfaces open the
/// identical detail panel.
export function upcomingBookingDetailItem(bk: BookingRow): CalendarItem {
  return {
    id: `booking:${bk.id}`,
    kind: "booking",
    title: bk.title,
    start: new Date(bk.startTime),
    end: new Date(bk.endTime),
    attendees: bk.attendeeEmail ? [{ email: bk.attendeeEmail, name: bk.attendeeName }] : undefined,
    videoLink: HOST.videoLink || undefined,
  };
}
