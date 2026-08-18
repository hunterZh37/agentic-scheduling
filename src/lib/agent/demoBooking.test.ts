import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/booking/service", () => ({
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { booking: { findMany: vi.fn() } } }));

import { bookDemoMeeting, cleanupDemoBookings, DEMO_ATTENDEE_EMAIL } from "./demoBooking";
import { createBooking, cancelBooking } from "@/lib/booking/service";
import { PERSONAS } from "./personas";

const persona = PERSONAS[0];
const slot = { startISO: "2026-07-21T18:00:00.000Z", endISO: "2026-07-21T18:30:00.000Z" };

beforeEach(() => {
  vi.mocked(createBooking).mockReset();
  vi.mocked(cancelBooking).mockReset();
});

describe("bookDemoMeeting", () => {
  it("books a tagged, alert-suppressed event with the fixed demo attendee", async () => {
    vi.mocked(createBooking).mockResolvedValue({ id: "b1" } as never);
    const out = await bookDemoMeeting(persona, slot);
    expect(out).toEqual({ ok: true });
    const arg = vi.mocked(createBooking).mock.calls[0][0];
    expect(arg.title).toBe(`[Demo] ${persona.name} <> Alex`);
    expect(arg.attendeeEmail).toBe(DEMO_ATTENDEE_EMAIL);
    expect(arg.attendeeName).toBe(persona.name);
    expect(arg.attendeeTimezone).toBe(persona.timezone);
    expect(arg.suppressHostAlert).toBe(true);
    expect(arg.suppressAttendeeEmail).toBe(true);
    expect(arg.createdVia).toBe("public_agent");
    expect(arg.start.toISOString()).toBe(slot.startISO);
    expect(arg.end.toISOString()).toBe(slot.endISO);
  });

  it("returns { ok:false, error } when createBooking throws", async () => {
    vi.mocked(createBooking).mockRejectedValue(new Error("too_soon"));
    const out = await bookDemoMeeting(persona, slot);
    expect(out).toEqual({ ok: false, error: "too_soon" });
  });
});

describe("cleanupDemoBookings", () => {
  it("cancels every listed demo booking and returns the count", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const listDemoBookings = vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const res = await cleanupDemoBookings({ listDemoBookings, cancel });
    expect(res).toEqual({ deleted: 3 });
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledWith("a");
  });

  it("continues past a single cancel failure and counts only successes", async () => {
    const cancel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(undefined);
    const listDemoBookings = vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const res = await cleanupDemoBookings({ listDemoBookings, cancel });
    expect(res).toEqual({ deleted: 2 });
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});
