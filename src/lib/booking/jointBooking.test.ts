import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreatedVia, type Account } from "@prisma/client";
import type { EventDraft } from "@/lib/calendar/write";

// The JOINT booking write: a booking made through a team link must (a) confirm
// EVERY member is free at write time, not just the owner, and (b) put every
// co-host on the invite so the event lands on their calendar too.

const DESTINATION = "owner@consulting-firm.test";
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

vi.mock("@/lib/db", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    account: { findFirst: vi.fn(), findMany: vi.fn() },
    personalBlock: { findMany: vi.fn() },
    todo: { findMany: vi.fn() },
    booking: { create: vi.fn() },
    reminder: { createMany: vi.fn() },
  },
}));
vi.mock("@/lib/calendar/aggregate", () => ({ fanOutBusy: vi.fn() }));
vi.mock("@/lib/availability/actionableBusy", () => ({ actionableBusy: vi.fn(async () => []) }));
vi.mock("@/lib/notify/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/sms/send", () => ({
  sendTwilioMessage: vi.fn(async () => {}),
  sendWhatsAppTemplate: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify/sms", () => ({ sendSms: vi.fn(async () => {}) }));

import { createBooking, BookingError } from "./service";
import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";

let drafts: EventDraft[];
const writeEvent = vi.fn(async (_acct: Account, draft: EventDraft) => {
  drafts.push(draft);
  return { id: "evt_1" };
});

const START = new Date("2026-09-15T17:00:00Z");
const END = new Date("2026-09-15T17:30:00Z");
const NOW = new Date("2026-09-01T00:00:00Z");

const jointBooking = (over: Record<string, unknown> = {}) => ({
  start: START,
  end: END,
  attendeeName: "Visitor",
  attendeeEmail: "visitor@example.net",
  attendeeTimezone: "America/Los_Angeles",
  createdVia: CreatedVia.public_link,
  now: NOW,
  coHostIds: ["ben"],
  additionalAttendeeEmails: ["ben@brooks.com"],
  teamId: "team_1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks(); // reset call history on every mock, incl. booking.create
  drafts = [];
  vi.mocked(prisma.settings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.personalBlock.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.account.findFirst).mockResolvedValue(account(DESTINATION, true) as never);
  vi.mocked(prisma.booking.create).mockImplementation((async (args: { data: { id?: string } }) => ({
    ...args.data,
    id: args.data.id ?? "bk_1",
    startTime: START,
    endTime: END,
    reminders: [],
  })) as never);
  vi.mocked(prisma.reminder.createMany).mockResolvedValue({ count: 0 } as never);
  // Everyone free by default. Clear call history so per-test assertions on which
  // subjects were fanned out don't see earlier tests' calls.
  vi.mocked(fanOutBusy).mockReset().mockResolvedValue({ busy: [], errors: [] } as never);
});

describe("joint booking re-checks every member", () => {
  it("fans out free/busy once per subject: owner (null) AND each co-host", async () => {
    await createBooking(jointBooking(), { writeEvent });
    const subjects = vi.mocked(fanOutBusy).mock.calls.map((c) => c[2]);
    expect(subjects).toEqual([null, "ben"]);
  });

  it("REJECTS the slot when the co-host is busy, even though the owner is free", async () => {
    vi.mocked(fanOutBusy).mockImplementation((_s, _e, id) =>
      Promise.resolve(
        id === "ben"
          ? { busy: [{ start: START, end: END }], errors: [] } // Ben is busy exactly then
          : { busy: [], errors: [] }
      ) as never
    );
    await expect(createBooking(jointBooking(), { writeEvent })).rejects.toBeInstanceOf(BookingError);
    expect(writeEvent).not.toHaveBeenCalled(); // never written
  });

  it("fails closed if any subject's free/busy cannot be verified", async () => {
    vi.mocked(fanOutBusy).mockImplementation((_s, _e, id) =>
      Promise.resolve(
        id === "ben" ? { busy: [], errors: [{ email: "ben@x", message: "token" }] } : { busy: [], errors: [] }
      ) as never
    );
    await expect(createBooking(jointBooking(), { writeEvent })).rejects.toMatchObject({
      code: "availability_unverified",
    });
    expect(writeEvent).not.toHaveBeenCalled();
  });

  it("scopes the block query to the owner and the team's co-hosts", async () => {
    await createBooking(jointBooking(), { writeEvent });
    expect(vi.mocked(prisma.personalBlock.findMany)).toHaveBeenCalledWith({
      where: { OR: [{ coHostId: null }, { coHostId: { in: ["ben"] } }] },
    });
  });
});

describe("joint booking invites every host", () => {
  it("adds the co-host emails to the event so it lands on their calendars", async () => {
    await createBooking(jointBooking(), { writeEvent });
    expect(drafts[0].attendeeEmail).toBe("visitor@example.net");
    expect(drafts[0].additionalAttendeeEmails).toEqual(["ben@brooks.com"]);
  });

  it("records the team on the booking row", async () => {
    await createBooking(jointBooking(), { writeEvent });
    expect(vi.mocked(prisma.booking.create).mock.calls[0][0].data).toMatchObject({ teamId: "team_1" });
  });
});

describe("an ordinary single-owner booking is unchanged", () => {
  it("fans out for the owner only and sets no co-host attendees or team", async () => {
    await createBooking(
      { ...jointBooking(), coHostIds: undefined, additionalAttendeeEmails: undefined, teamId: undefined },
      { writeEvent }
    );
    expect(vi.mocked(fanOutBusy).mock.calls.map((c) => c[2])).toEqual([null]);
    expect(drafts[0].additionalAttendeeEmails).toBeUndefined();
    expect(vi.mocked(prisma.booking.create).mock.calls[0][0].data.teamId).toBeUndefined();
  });
});
