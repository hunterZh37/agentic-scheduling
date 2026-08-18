import { describe, it, expect } from "vitest";
import { visibleUpcomingBookings, dismissKey, CANCELLED_VISIBLE_MS } from "./upcomingBookings";
import type { BookingRow } from "./detailItem";

// A cancelled booking has to stay visible long enough for the owner to notice
// it — a meeting that vanishes without a trace looks exactly like one that was
// never made — and then get out of the way on its own.

const NOW = new Date("2026-08-12T18:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: "bk_1",
  title: "Someone <> Hunter",
  startTime: "2026-08-20T17:00:00Z",
  endTime: "2026-08-20T17:30:00Z",
  attendeeName: "Someone",
  attendeeTimezone: "America/Los_Angeles",
  status: "confirmed",
  ...over,
});

const none = new Set<string>();

describe("visibleUpcomingBookings", () => {
  it("always shows confirmed bookings, however old the row is", () => {
    const rows = [booking({ updatedAt: ago(30 * 24 * 60 * 60 * 1000) })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toHaveLength(1);
  });

  it("shows a booking cancelled in the last 24 hours", () => {
    const rows = [booking({ status: "cancelled", updatedAt: ago(2 * 60 * 60 * 1000) })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toHaveLength(1);
  });

  it("hides one cancelled more than 24 hours ago", () => {
    const rows = [booking({ status: "cancelled", updatedAt: ago(CANCELLED_VISIBLE_MS + 60_000) })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toEqual([]);
  });

  it("still shows one cancelled a minute before the deadline", () => {
    const rows = [booking({ status: "cancelled", updatedAt: ago(CANCELLED_VISIBLE_MS - 60_000) })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toHaveLength(1);
  });

  it("hides a dismissed cancellation immediately, deadline or not", () => {
    const rows = [booking({ id: "bk_x", status: "cancelled", updatedAt: ago(60_000) })];

    expect(visibleUpcomingBookings(rows, new Set([dismissKey("bk_x")]), NOW)).toEqual([]);
  });

  it("does not let a dismissal hide a CONFIRMED booking", () => {
    // Dismissal is only offered on cancelled rows, but a stale key must never
    // be able to hide a real meeting.
    const rows = [booking({ id: "bk_x" })];

    expect(visibleUpcomingBookings(rows, new Set([dismissKey("bk_x")]), NOW)).toHaveLength(1);
  });

  it("keeps a cancelled booking with no updatedAt rather than hiding it", () => {
    // Failing towards showing too much is recoverable with the trash control;
    // failing towards hiding is not.
    const rows = [booking({ status: "cancelled", updatedAt: undefined })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toHaveLength(1);
  });

  it("keeps one whose updatedAt is unparseable", () => {
    const rows = [booking({ status: "cancelled", updatedAt: "not a date" })];

    expect(visibleUpcomingBookings(rows, none, NOW)).toHaveLength(1);
  });

  it("returns them in start order, mixing confirmed and cancelled", () => {
    const rows = [
      booking({ id: "c", startTime: "2026-08-22T17:00:00Z" }),
      booking({ id: "a", status: "cancelled", updatedAt: ago(60_000), startTime: "2026-08-19T17:00:00Z" }),
      booking({ id: "b", startTime: "2026-08-21T17:00:00Z" }),
    ];

    expect(visibleUpcomingBookings(rows, none, NOW).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [
      booking({ id: "later", startTime: "2026-08-25T17:00:00Z" }),
      booking({ id: "sooner", startTime: "2026-08-13T17:00:00Z" }),
    ];

    visibleUpcomingBookings(rows, none, NOW);

    expect(rows.map((b) => b.id)).toEqual(["later", "sooner"]);
  });
});
