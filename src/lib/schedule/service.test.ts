import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    account: { findMany: vi.fn().mockResolvedValue([]) },
    personalBlock: { findMany: vi.fn().mockResolvedValue([]) },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
    todo: { findMany: vi.fn().mockResolvedValue([]) },
    birthday: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/calendar/read", () => ({ listEvents: vi.fn() }));

import { getScheduleView } from "./service";
import { prisma } from "@/lib/db";
import { listEvents } from "@/lib/calendar/read";

beforeEach(() => {
  vi.mocked(prisma.birthday.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.account.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.personalBlock.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.booking.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.todo.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(listEvents).mockReset().mockResolvedValue([] as never);
});

describe("getScheduleView is scoped to the owner (co-host privacy wall)", () => {
  // The owner's dashboard must never surface a co-host's connected calendars or
  // reserved blocks. Both queries filter coHostId=null.
  it("loads only owner accounts and owner blocks", async () => {
    await getScheduleView(new Date("2026-07-16T00:00:00Z"), new Date("2026-07-17T00:00:00Z"));
    expect(vi.mocked(prisma.account.findMany)).toHaveBeenCalledWith({ where: { coHostId: null } });
    expect(vi.mocked(prisma.personalBlock.findMany)).toHaveBeenCalledWith({
      where: { visible: true, coHostId: null },
    });
  });
});

describe("getScheduleView booking/event dedup", () => {
  it("drops the synced provider event that belongs to a booking (no duplicate)", async () => {
    vi.mocked(prisma.account.findMany).mockResolvedValue([
      { id: "a", email: "dest@x.com", visible: true },
    ] as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      { id: "bk1", title: "Brian <> Alex", startTime: new Date("2026-07-16T19:00:00Z"), endTime: new Date("2026-07-16T19:30:00Z"), attendeeName: "Brian", attendeeEmail: "b@x.com", attendeeTimezone: "UTC", status: "confirmed", externalEventId: "evt-x1" },
    ] as never);
    vi.mocked(listEvents).mockResolvedValue([
      { id: "evt-x1", title: "Brian <> Alex", start: new Date("2026-07-16T19:00:00Z"), end: new Date("2026-07-16T19:30:00Z"), accountEmail: "dest@x.com", allDay: false },
      { id: "evt-x2", title: "Other meeting", start: new Date("2026-07-16T21:00:00Z"), end: new Date("2026-07-16T22:00:00Z"), accountEmail: "dest@x.com", allDay: false },
    ] as never);
    const view = await getScheduleView(new Date("2026-07-16T00:00:00Z"), new Date("2026-07-17T00:00:00Z"));
    // evt-x1 (the booking's synced event) is filtered out; evt-x2 stays; booking remains.
    expect(view.events.map((e) => e.id)).toEqual(["evt-x2"]);
    expect(view.bookings.map((b) => b.id)).toEqual(["bk1"]);
  });
});

describe("getScheduleView birthdays", () => {
  it("includes birthday occurrences within the range", async () => {
    vi.mocked(prisma.birthday.findMany).mockResolvedValue([
      { id: "m", name: "Martin", month: 7, day: 5, year: 1996 },
    ] as never);
    const view = await getScheduleView(new Date("2026-07-01T07:00:00Z"), new Date("2026-08-01T07:00:00Z"));
    expect(view.birthdays).toHaveLength(1);
    expect(view.birthdays[0]).toMatchObject({ name: "Martin", age: 30 });
  });

  it("degrades gracefully when the birthday query fails (does not break the whole view)", async () => {
    // e.g. the Birthday table doesn't exist yet (pre-migration). The rest of the
    // schedule must still load; birthdays become empty + a visible warning.
    vi.mocked(prisma.birthday.findMany).mockRejectedValue(
      new Error('relation "Birthday" does not exist')
    );
    const view = await getScheduleView(new Date("2026-07-01T07:00:00Z"), new Date("2026-08-01T07:00:00Z"));
    expect(view.birthdays).toEqual([]);
    expect(view.warnings.some((w) => w.email === "birthdays")).toBe(true);
  });
});

describe("getScheduleView actionables", () => {
  it("surfaces timed to-dos as actionables, not as events", async () => {
    vi.mocked(prisma.todo.findMany).mockResolvedValue([
      {
        id: "t1",
        title: "Email the deck",
        startTime: new Date("2026-07-16T17:00:00Z"),
        endTime: new Date("2026-07-16T17:30:00Z"),
        done: false,
        location: null,
        videoLink: null,
      },
    ] as never);
    const view = await getScheduleView(new Date("2026-07-16T00:00:00Z"), new Date("2026-07-17T00:00:00Z"));
    expect(view.actionables).toHaveLength(1);
    expect(view.actionables![0]).toMatchObject({ id: "t1", title: "Email the deck", done: false });
    // Actionables are their own kind — they are never mixed into events.
    expect(view.events).toEqual([]);
  });
});
