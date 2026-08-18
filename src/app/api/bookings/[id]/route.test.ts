import { describe, it, expect, vi, beforeEach } from "vitest";

// Owner-reported (2026-08-20): the booking popover showed a bare "Cancel
// booking" instead of the Edit button every other item has. Bookings are now
// editable, and saving a time change reschedules — which re-invites the
// attendee. These pin the new owner reschedule endpoint's contract.
vi.mock("@/lib/booking/service", () => ({
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  BookingError: class BookingError extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

import { PATCH } from "./route";
import { rescheduleBooking, BookingError } from "@/lib/booking/service";

const patch = (id: string, body?: unknown) =>
  PATCH(
    new Request(`https://x/api/bookings/${id}`, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  vi.mocked(rescheduleBooking)
    .mockReset()
    .mockResolvedValue({
      id: "new-id",
      startTime: new Date("2026-08-21T17:00:00Z"),
      endTime: new Date("2026-08-21T17:30:00Z"),
    } as never);
});

describe("PATCH /api/bookings/[id] — owner reschedule", () => {
  it("reschedules to the new time (and title) and returns the new booking", async () => {
    const res = await patch("b1", {
      start: "2026-08-21T17:00:00Z",
      end: "2026-08-21T17:30:00Z",
      title: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(rescheduleBooking).toHaveBeenCalledWith("b1", {
      start: new Date("2026-08-21T17:00:00Z"),
      end: new Date("2026-08-21T17:30:00Z"),
      title: "Renamed",
    });
    expect((await res.json()).id).toBe("new-id");
  });

  it("rejects a missing time (400) without touching the booking", async () => {
    const res = await patch("b1", { start: "2026-08-21T17:00:00Z" });
    expect(res.status).toBe(400);
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });

  it("rejects end on or before start (400)", async () => {
    const res = await patch("b1", { start: "2026-08-21T17:30:00Z", end: "2026-08-21T17:00:00Z" });
    expect(res.status).toBe(400);
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });

  it("maps a gone booking to 404", async () => {
    vi.mocked(rescheduleBooking).mockRejectedValueOnce(new BookingError("booking_not_found", "gone"));
    const res = await patch("b1", { start: "2026-08-21T17:00:00Z", end: "2026-08-21T17:30:00Z" });
    expect(res.status).toBe(404);
  });
});
