import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { agendaDetailItem, untimedTodoDetailItem, upcomingBookingDetailItem, type AgendaItem, type BookingRow } from "./detailItem";

const base = {
  title: "Item",
  start: "2026-08-08T19:00:00.000Z",
  end: "2026-08-08T19:30:00.000Z",
  allDay: false,
  colorVar: "--accent",
};

describe("agendaDetailItem", () => {
  it("maps an event row to a modal item with the bare provider id", () => {
    const item: AgendaItem = {
      ...base,
      key: "event:abc123:2026-08-08T19:00:00.000Z",
      kind: "event",
      eventId: "abc123",
      accountEmail: "me@example.com",
      location: "HQ",
      description: "notes",
      videoLink: "https://meet.example.com/x",
      htmlLink: "https://cal.example.com/e/abc123",
    };
    const d = agendaDetailItem(item)!;
    expect(d.kind).toBe("event");
    // Bare `event:<id>` (no occurrence start) — the modal's provider
    // edit/delete and follow-up key both depend on this exact form.
    expect(d.id).toBe("event:abc123");
    expect(d.start).toEqual(new Date(base.start));
    expect(d.end).toEqual(new Date(base.end));
    expect(d.accountEmail).toBe("me@example.com");
    expect(d.location).toBe("HQ");
    expect(d.videoLink).toBe("https://meet.example.com/x");
    expect(d.htmlLink).toBe("https://cal.example.com/e/abc123");
  });

  it("maps a block row", () => {
    const item: AgendaItem = { ...base, key: "block:b1:x", kind: "block", blockId: "b1" };
    const d = agendaDetailItem(item)!;
    expect(d.kind).toBe("block");
    expect(d.title).toBe("Item");
  });

  it("maps a booking row, carrying the attendee into the modal", () => {
    const item: AgendaItem = {
      ...base,
      key: "booking:bk1",
      kind: "booking",
      bookingId: "bk1",
      attendeeName: "Abraham & Camilo",
      attendeeEmail: "abraham@example.com",
    };
    const d = agendaDetailItem(item)!;
    expect(d.kind).toBe("booking");
    expect(d.id).toBe("booking:bk1");
    expect(d.attendees).toEqual([{ email: "abraham@example.com", name: "Abraham & Camilo" }]);
  });

  it("maps a timed todo to an actionable", () => {
    const item: AgendaItem = { ...base, key: "todo:t1", kind: "todo", todoId: "t1", phone: "555-1234" };
    const d = agendaDetailItem(item)!;
    expect(d.kind).toBe("actionable");
    expect(d.id).toBe("actionable:t1");
    expect(d.phone).toBe("555-1234");
  });

  it("returns undefined only for birthdays (read-only markers)", () => {
    const item: AgendaItem = { ...base, key: "birthday:x", kind: "birthday" };
    expect(agendaDetailItem(item)).toBeUndefined();
  });
});

// Reported 2026-08-19: an untimed actionable ("Review Keith's document") had no
// click target, so it was the one agenda row you couldn't open to edit. This
// pins the detail it now opens with.
describe("untimedTodoDetailItem", () => {
  const day = DateTime.fromISO("2026-08-19T00:00:00", { zone: "America/Los_Angeles" });

  it("maps an untimed to-do to an editable actionable detail", () => {
    const d = untimedTodoDetailItem({ id: "t1", title: "Review Keith's document" }, day);
    expect(d.id).toBe("actionable:t1");
    expect(d.kind).toBe("actionable");
    expect(d.title).toBe("Review Keith's document");
  });

  it("seeds a 30-minute default slot at 9:00 AM local on the given day", () => {
    const d = untimedTodoDetailItem({ id: "t1", title: "x" }, day);
    const start = DateTime.fromJSDate(d.start).setZone("America/Los_Angeles");
    const end = DateTime.fromJSDate(d.end).setZone("America/Los_Angeles");
    expect(start.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-08-19 09:00");
    expect(end.diff(start, "minutes").minutes).toBe(30);
  });

  it("carries the where fields through", () => {
    const d = untimedTodoDetailItem({ id: "t1", title: "x", location: "Office", phone: "555" }, day);
    expect(d.location).toBe("Office");
    expect(d.phone).toBe("555");
  });
});

describe("upcomingBookingDetailItem", () => {
  const bk: BookingRow = {
    id: "bk9",
    title: "Abraham & Camilo <> Hunter",
    startTime: "2026-08-08T20:00:00.000Z",
    endTime: "2026-08-08T20:30:00.000Z",
    attendeeName: "Abraham & Camilo",
    attendeeEmail: "abraham@example.com",
    attendeeTimezone: "America/Denver",
    status: "confirmed",
  };

  it("maps an Upcoming-bookings row to the same modal shape the agenda uses", () => {
    const d = upcomingBookingDetailItem(bk);
    expect(d.kind).toBe("booking");
    expect(d.id).toBe("booking:bk9");
    expect(d.start).toEqual(new Date(bk.startTime));
    expect(d.end).toEqual(new Date(bk.endTime));
    expect(d.attendees).toEqual([{ email: "abraham@example.com", name: "Abraham & Camilo" }]);
  });

  it("omits attendees when the row has no email", () => {
    const d = upcomingBookingDetailItem({ ...bk, attendeeEmail: undefined });
    expect(d.attendees).toBeUndefined();
  });
});

// The detail panel opened, showed the time and the guest, and no way to join —
// while the attendee's invite carried the owner's room link all along. Every
// booking meets in that room, so the panel can and should show it.
describe("bookings carry a join link", () => {
  it("agenda booking rows include the owner's room", () => {
    const d = agendaDetailItem({
      key: "booking:b1",
      kind: "booking",
      title: "Abraham & Camilo <> Hunter",
      start: "2026-08-08T19:00:00.000Z",
      end: "2026-08-08T19:30:00.000Z",
      allDay: false,
      colorVar: "--state-booking",
      bookingId: "b1",
      attendeeName: "Abraham & Camilo",
      attendeeEmail: "abraham.behar@summitcp.com",
    })!;
    // HOST.videoLink comes from NEXT_PUBLIC_OWNER_VIDEO_LINK, which is unset in
    // tests — so assert the field is wired, not a particular URL.
    expect("videoLink" in d).toBe(true);
  });

  it("upcoming-bookings rows include it too", () => {
    const d = upcomingBookingDetailItem({
      id: "b1",
      title: "Abraham & Camilo <> Hunter",
      startTime: "2026-08-08T19:00:00.000Z",
      endTime: "2026-08-08T19:30:00.000Z",
      attendeeName: "Abraham & Camilo",
      attendeeEmail: "abraham.behar@summitcp.com",
      attendeeTimezone: "America/Los_Angeles",
      status: "confirmed",
    });
    expect("videoLink" in d).toBe(true);
  });
});
