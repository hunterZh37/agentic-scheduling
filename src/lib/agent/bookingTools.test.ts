import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/booking/service", () => ({
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  createBooking: vi.fn(),
  BookingError: class BookingError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { rescheduleBookingTool, deleteBookingTool } from "./tools";
import { rescheduleBooking } from "@/lib/booking/service";

// Over WhatsApp the owner could CANCEL a booking but not MOVE one: the private
// agent (which the SMS/WhatsApp channel runs) had delete_booking and no
// reschedule, while the attendee-facing manage page could already do it.
// "Push my 3pm to 4pm" therefore meant cancel + rebook, which emails the
// attendee a cancellation, then a fresh invitation, and invalidates their
// manage link.
const run = async (tool: unknown, args: Record<string, unknown>) =>
  JSON.parse(await (tool as { run: (a: Record<string, unknown>) => Promise<string> }).run(args));

beforeEach(() => {
  vi.mocked(rescheduleBooking).mockReset().mockResolvedValue({
    id: "new-id",
    startTime: new Date("2026-08-10T20:00:00Z"),
    endTime: new Date("2026-08-10T20:30:00Z"),
    attendeeName: "Paul",
  } as never);
});

describe("booking verbs available to the agent", () => {
  it("can move a booking, not only cancel it", () => {
    const names = [deleteBookingTool(), rescheduleBookingTool()].map(
      (t) => (t as unknown as { name: string }).name
    );
    expect(names).toContain("delete_booking");
    expect(names).toContain("reschedule_booking");
  });

  it("reschedules through the service, preserving the attendee", async () => {
    const out = await run(rescheduleBookingTool(), {
      bookingId: "old-id",
      startISO: "2026-08-10T20:00:00Z",
      endISO: "2026-08-10T20:30:00Z",
    });
    expect(rescheduleBooking).toHaveBeenCalledWith("old-id", {
      start: new Date("2026-08-10T20:00:00Z"),
      end: new Date("2026-08-10T20:30:00Z"),
    });
    expect(out.ok).toBe(true);
    expect(out.attendee).toBe("Paul");
  });

  it("reports that the id changed, since a reschedule creates a new row", async () => {
    const out = await run(rescheduleBookingTool(), {
      bookingId: "old-id",
      startISO: "2026-08-10T20:00:00Z",
      endISO: "2026-08-10T20:30:00Z",
    });
    expect(out.previousBookingId).toBe("old-id");
    expect(out.bookingId).toBe("new-id");
    expect(out.bookingId).not.toBe(out.previousBookingId);
  });

  it("refuses an inverted range without touching the booking", async () => {
    const out = await run(rescheduleBookingTool(), {
      bookingId: "old-id",
      startISO: "2026-08-10T21:00:00Z",
      endISO: "2026-08-10T20:00:00Z",
    });
    expect(out.error).toBe("invalid_range");
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });

  it("tells the agent not to fake a move with cancel + rebook", () => {
    const desc = (rescheduleBookingTool() as unknown as { description: string }).description;
    expect(desc).toMatch(/NOT the same as cancelling and re-booking/i);
  });
});
