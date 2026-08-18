import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreatedVia, type Account } from "@prisma/client";

// Where does a booking actually land?
//
// The owner moved bookings from a personal calendar to a work one, and "all
// future bookings" has to mean *every* path in: the public booking page, the
// public agent, the MCP tool other people's agents call, and a reschedule of an
// existing booking. Each of those calls createBooking separately. If any one of
// them names a calendar of its own, or falls back to "first account" when the
// destination lookup misses, bookings quietly split across two calendars and
// nobody notices until a meeting is missed.
//
// Six other connected accounts sit in the fixture as decoys, so "it happened to
// pick the right one" cannot pass.

const DESTINATION = "owner@consulting-firm.test";
const DECOYS = [
  "owner@nonprofit-a.test",
  "owner@nonprofit-b.test",
  "owner@startup-a.test",
  "owner@research-lab.test",
  "owner@personal-mail.test",
  "owner@alumni-school.test",
];

const account = (email: string, isDestination = false) =>
  ({
    id: email,
    email,
    isDestination,
    refreshToken: "tok",
    accessToken: "tok",
    provider: "google",
    checkForConflicts: true,
  }) as unknown as Account;

const ALL = [...DECOYS.map((e) => account(e)), account(DESTINATION, true)];

vi.mock("@/lib/db", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    account: { findFirst: vi.fn(), findMany: vi.fn() },
    personalBlock: { findMany: vi.fn() },
    todo: { findMany: vi.fn() },
    booking: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    reminder: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// No live free/busy, and nothing is busy — this suite is about routing, not
// about availability, which has its own tests.
vi.mock("@/lib/calendar/aggregate", () => ({
  fanOutBusy: vi.fn(async () => ({ busy: [], errors: [] })),
}));
vi.mock("@/lib/availability/actionableBusy", () => ({
  actionableBusy: vi.fn(async () => []),
}));
vi.mock("@/lib/notify/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/sms/send", () => ({
  sendTwilioMessage: vi.fn(async () => {}),
  sendWhatsAppTemplate: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify/sms", () => ({ sendSms: vi.fn(async () => {}) }));

import { createBooking } from "./service";
import { prisma } from "@/lib/db";

/// Records which account each write was aimed at.
let written: string[];
const writeEvent = vi.fn(async (acct: Account) => {
  written.push(acct.email);
  return { id: `evt_${written.length}` };
});

const START = new Date("2026-09-15T17:00:00Z");
const END = new Date("2026-09-15T17:30:00Z");

const booking = (over: Record<string, unknown> = {}) => ({
  start: START,
  end: END,
  attendeeName: "Stress Test",
  attendeeEmail: "visitor@example.net",
  attendeeTimezone: "America/Los_Angeles",
  createdVia: CreatedVia.public_link,
  now: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  written = [];
  writeEvent.mockClear();
  vi.mocked(prisma.settings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.personalBlock.findMany).mockResolvedValue([] as never);
  // The destination lookup the service performs: `where: { isDestination: true }`.
  vi.mocked(prisma.account.findFirst).mockImplementation((async (args: {
    where?: { isDestination?: boolean; email?: string };
  }) => {
    if (args?.where?.email) return ALL.find((a) => a.email === args.where!.email) ?? null;
    if (args?.where?.isDestination) return ALL.find((a) => a.isDestination) ?? null;
    return ALL[0];
  }) as never);
  vi.mocked(prisma.account.findMany).mockResolvedValue(ALL as never);
  vi.mocked(prisma.booking.create).mockImplementation((async (args: { data: { id?: string } }) => ({
    ...args.data,
    id: args.data.id ?? "bk_1",
    reminders: [],
  })) as never);
  vi.mocked(prisma.reminder.createMany).mockResolvedValue({ count: 0 } as never);
});

describe("every booking lands on the destination calendar", () => {
  it("writes a visitor's booking to the destination, not to any other calendar", async () => {
    await createBooking(booking(), { writeEvent });

    expect(written).toEqual([DESTINATION]);
  });

  it("ignores the six other connected calendars", async () => {
    await createBooking(booking(), { writeEvent });

    for (const decoy of DECOYS) expect(written).not.toContain(decoy);
  });

  it("follows the flag when the destination moves, with no code change", async () => {
    // The switch is data, not configuration: flipping the row must be enough.
    const moved = [account(DESTINATION), account("owner@myrealmail.com", true), ...DECOYS.slice(0, 3).map((e) => account(e))];
    vi.mocked(prisma.account.findFirst).mockImplementation((async (args: {
      where?: { isDestination?: boolean };
    }) => (args?.where?.isDestination ? moved.find((a) => a.isDestination) : moved[0])) as never);

    await createBooking(booking(), { writeEvent });

    expect(written).toEqual(["owner@myrealmail.com"]);
  });

  it("refuses to book rather than guessing when no calendar is the destination", async () => {
    // The dangerous failure is a silent fallback to "the first account": the
    // booking succeeds and lands somewhere nobody is watching.
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null as never);

    await expect(createBooking(booking(), { writeEvent })).rejects.toMatchObject({
      code: "no_destination",
    });
    expect(written).toEqual([]);
  });

  it("refuses when the destination has no stored credentials", async () => {
    const disconnected = { ...account(DESTINATION, true), refreshToken: null, accessToken: null };
    vi.mocked(prisma.account.findFirst).mockResolvedValue(disconnected as never);

    await expect(createBooking(booking(), { writeEvent })).rejects.toMatchObject({
      code: "destination_not_connected",
    });
    // Nothing written: a booking must never be confirmed against a calendar we
    // cannot actually write to.
    expect(written).toEqual([]);
  });

  it("sends 25 concurrent bookings to one and the same calendar", async () => {
    // Different durations and start times, all at once — the routing must not
    // depend on ordering or on a cached first lookup.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createBooking(
          booking({
            start: new Date(START.getTime() + i * 3_600_000),
            end: new Date(START.getTime() + i * 3_600_000 + 1_800_000),
            attendeeEmail: `visitor${i}@example.net`,
          }),
          { writeEvent }
        )
      )
    );

    expect(written).toHaveLength(25);
    expect(new Set(written)).toEqual(new Set([DESTINATION]));
  });

  it("puts a rescheduled booking on the CURRENT destination", async () => {
    // A reschedule re-creates the event. An old booking made on the previous
    // calendar therefore moves to the new one — worth knowing, and worth
    // pinning down, because the alternative (writing to the booking's original
    // account) would keep resurrecting the old calendar after the switch.
    await createBooking(booking({ title: "Moved meeting", suppressHostAlert: true }), { writeEvent });

    expect(written).toEqual([DESTINATION]);
  });
});
