import { HOST } from "@/lib/booking/publicConfig";

export type CalendarItemKind = "event" | "booking" | "block" | "birthday" | "actionable";

export type AttendeeStatus = "accepted" | "declined" | "tentative" | "needsAction";
export interface ItemAttendee {
  email: string;
  name?: string;
  responseStatus?: AttendeeStatus;
  organizer?: boolean;
}

export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  start: Date;
  end: Date;
  /// Present for real calendar events — drives the account color.
  accountEmail?: string;
  // Detail (present mainly on real events; used by the event detail modal).
  location?: string;
  description?: string;
  videoLink?: string;
  /// Actionables only: a phone number to call (Todo.phone).
  phone?: string;
  organizer?: { email: string; name?: string };
  attendees?: ItemAttendee[];
  reminders?: number[];
  htmlLink?: string;
}

interface ApiEvent {
  id: string;
  accountEmail: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  videoLink?: string;
  organizer?: { email: string; name?: string };
  attendees?: ItemAttendee[];
  reminders?: number[];
  htmlLink?: string;
}

/// Raw API shape from GET /api/schedule (ISO strings).
export interface ScheduleApiResponse {
  events: ApiEvent[];
  blocks: Array<{ id: string; title: string; start: string; end: string }>;
  bookings: Array<{ id: string; title: string; start: string; end: string; attendeeName: string; attendeeEmail?: string; status: string }>;
  birthdays: Array<{ id: string; name: string; date: string; age: number | null }>;
  actionables?: Array<{ id: string; title: string; start: string; end: string; done: boolean; location: string | null; videoLink: string | null; phone: string | null }>;
  warnings: Array<{ email: string; message: string }>;
}

export function toCalendarItems(res: ScheduleApiResponse): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const e of res.events) {
    if (e.allDay) continue; // all-day events aren't placed on the timed grid (v1)
    items.push({
      id: `event:${e.id}`,
      kind: "event",
      title: e.title,
      start: new Date(e.start),
      end: new Date(e.end),
      accountEmail: e.accountEmail,
      location: e.location,
      description: e.description,
      videoLink: e.videoLink,
      organizer: e.organizer,
      attendees: e.attendees,
      reminders: e.reminders,
      htmlLink: e.htmlLink,
    });
  }
  for (const b of res.blocks) {
    // A recurring block expands to multiple occurrences that share the same DB
    // id (and an overnight block can put two occurrences in one day), so include
    // the occurrence start to keep React keys unique.
    items.push({ id: `block:${b.id}:${b.start}`, kind: "block", title: b.title, start: new Date(b.start), end: new Date(b.end) });
  }
  for (const bk of res.bookings) {
    items.push({
      id: `booking:${bk.id}`,
      kind: "booking",
      title: bk.title,
      start: new Date(bk.start),
      end: new Date(bk.end),
      attendees: bk.attendeeEmail ? [{ email: bk.attendeeEmail, name: bk.attendeeName }] : undefined,
      // Bookings all meet in the owner's room; the invite carries it, so the
      // detail panel should show it too.
      videoLink: HOST.videoLink || undefined,
    });
  }
  for (const b of res.birthdays) {
    const start = new Date(b.date);
    items.push({
      id: `birthday:${b.id}:${b.date}`,
      kind: "birthday",
      title: `🎂 ${b.name}${b.age != null ? ` (${b.age})` : ""}`,
      start,
      end: start,
    });
  }
  for (const a of res.actionables ?? []) {
    items.push({
      id: `actionable:${a.id}`,
      kind: "actionable",
      title: a.title,
      start: new Date(a.start),
      end: new Date(a.end),
      location: a.location ?? undefined,
      videoLink: a.videoLink ?? undefined,
      phone: a.phone ?? undefined,
    });
  }
  return items;
}
