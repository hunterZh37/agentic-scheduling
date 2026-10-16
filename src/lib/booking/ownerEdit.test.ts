import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreatedVia, type Account } from "@prisma/client";
import type { EventDraft } from "@/lib/calendar/write";

// "there should not be any conflict tho" (owner, 2026-10-15): the owner moved
// a booking onto their own Lunch/Dinner reserved block and was refused like a
// visitor would be. Reserved blocks and carried-over actionables are the
// owner's own fences; an owner edit steps over them. A real calendar event
// still refuses, and a visitor is still fenced.

const DESTINATION = "owner@consulting-firm.test";
const account = () =>
  ({ id: DESTINATION, email: DESTINATION, isDestination: true, refreshToken: "tok", accessToken: "tok", provider: "google", checkForConflicts: true }) as unknown as Account;

vi.mock("@/lib/db", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    account: { findFirst: vi.fn(), findMany: vi.fn() },
    personalBlock: { findMany: vi.fn() },
    todo: { findMany: vi.fn() },
    booking: { create: vi.fn(), findMany: vi.fn(async () => []) },
    reminder: { createMany: vi.fn() },
  },
}));
vi.mock("@/lib/calendar/aggregate", () => ({ fanOutBusy: vi.fn() }));
vi.mock("@/lib/availability/actionableBusy", () => ({ actionableBusy: vi.fn(async () => []) }));
vi.mock("@/lib/notify/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/sms/send", () => ({ sendTwilioMessage: vi.fn(async () => {}), sendWhatsAppTemplate: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/sms", () => ({ sendSms: vi.fn(async () => {}) }));

import { createBooking, BookingError } from "./service";

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof BookingError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a rejection");
};
import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";
import { actionableBusy } from "@/lib/availability/actionableBusy";

const writeEvent = vi.fn(async (_a: Account, _d: EventDraft) => ({ id: "evt_1" }));
// Fri 2026-10-16, 3–4 PM Pacific.
const START = new Date("2026-10-16T22:00:00Z");
const END = new Date("2026-10-16T23:00:00Z");
const NOW = new Date("2026-10-15T20:00:00Z");
// Weekday Lunch/Dinner block, 2:30–3:20 PM Pacific.
const lunch = {
  id: "blk_lunch", title: "Lunch/Dinner", timezone: "America/Los_Angeles", coHostId: null,
  startTime: new Date("2026-07-13T21:30:00Z"), endTime: new Date("2026-07-13T22:20:00Z"),
  recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
};
const booking = (over: Record<string, unknown> = {}) => ({
  start: START, end: END, attendeeName: "German", attendeeEmail: "german@example.net",
  attendeeTimezone: "America/Los_Angeles", createdVia: CreatedVia.public_link, now: NOW, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.settings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.personalBlock.findMany).mockResolvedValue([lunch] as never);
  vi.mocked(prisma.todo.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.account.findFirst).mockResolvedValue(account() as never);
  vi.mocked(prisma.booking.create).mockImplementation((async (args: { data: { id?: string } }) => ({ ...args.data, id: args.data.id ?? "bk_1", startTime: START, endTime: END, reminders: [] })) as never);
  vi.mocked(prisma.reminder.createMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(fanOutBusy).mockResolvedValue({ busy: [], errors: [] } as never);
});

describe("owner edits step over the owner's own fences", () => {
  it("a visitor is refused by the reserved block, and told which one", async () => {
    expect(await rejection(createBooking(booking(), { writeEvent }))).toEqual({
      code: "conflict",
      message: 'Slot cannot be booked: it overlaps reserved time "Lunch/Dinner" (2:30 – 3:20 PM).',
    });
  });

  it("the owner's edit is not", async () => {
    await createBooking(booking({ ownerEdit: true }), { writeEvent });
    expect(writeEvent).toHaveBeenCalledTimes(1);
  });

  it("nor by a carried-over actionable, nor by notice or horizon rules", async () => {
    vi.mocked(actionableBusy).mockResolvedValue([{ start: START, end: END }]);
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ minNoticeHours: 48, bookingHorizonDays: 1, bufferMinutes: 0, reminderOffsetsMinutes: [] } as never);
    await expect(createBooking(booking(), { writeEvent })).rejects.toBeInstanceOf(BookingError);
    await createBooking(booking({ ownerEdit: true }), { writeEvent });
    expect(writeEvent).toHaveBeenCalledTimes(1);
  });

  it("a real calendar event still refuses the owner", async () => {
    vi.mocked(fanOutBusy).mockResolvedValue({ busy: [{ start: START, end: END }], errors: [] } as never);
    expect(await rejection(createBooking(booking({ ownerEdit: true }), { writeEvent }))).toEqual({
      code: "conflict",
      message: "Slot cannot be booked: it overlaps a calendar event.",
    });
  });
});
