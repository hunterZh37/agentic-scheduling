import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    personalBlock: { findMany: vi.fn() },
    todo: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/calendar/aggregate", () => ({ fanOutBusy: vi.fn() }));

import { getAvailability } from "./service";
import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";

const NOW = new Date("2026-08-03T17:00:00Z");

beforeEach(() => {
  vi.mocked(prisma.settings.findUnique).mockReset().mockResolvedValue({
    bookingHorizonDays: 60,
    minNoticeHours: 2,
    bufferMinutes: 0,
    defaultEventDurationMinutes: 30,
  } as never);
  vi.mocked(prisma.personalBlock.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(prisma.todo.findMany).mockReset().mockResolvedValue([] as never);
  vi.mocked(fanOutBusy).mockReset().mockResolvedValue({ busy: [], errors: [] } as never);
});

describe("getAvailability provider window", () => {
  // Regression: the raw requested range used to be fanned out to the calendar
  // providers. Google rejects over-wide free/busy queries, and a failed account
  // contributes no busy intervals — so a multi-month request silently dropped
  // every busy interval and advertised real meetings as free.
  it("clamps the provider free/busy query to the booking horizon", async () => {
    await getAvailability({
      requestedStart: new Date("2026-08-04T00:00:00Z"),
      requestedEnd: new Date("2027-08-04T00:00:00Z"), // a year out
      now: NOW,
    });
    const [start, end] = vi.mocked(fanOutBusy).mock.calls[0];
    const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
    // 60-day horizon from NOW, not the 365-day request.
    expect(spanDays).toBeLessThanOrEqual(61);
    expect(end.getTime()).toBeLessThanOrEqual(NOW.getTime() + 60 * 86_400_000);
  });

  it("does not call the providers at all for a range outside the bookable window", async () => {
    const r = await getAvailability({
      requestedStart: new Date("2020-01-01T00:00:00Z"),
      requestedEnd: new Date("2020-01-02T00:00:00Z"), // entirely in the past
      now: NOW,
    });
    expect(r.slots).toEqual([]);
    expect(vi.mocked(fanOutBusy)).not.toHaveBeenCalled();
  });

  it("passes a normal in-window range through unclamped", async () => {
    const start = new Date("2026-08-04T00:00:00Z");
    const end = new Date("2026-08-11T00:00:00Z");
    await getAvailability({ requestedStart: start, requestedEnd: end, now: NOW });
    const [gotStart, gotEnd] = vi.mocked(fanOutBusy).mock.calls[0];
    expect(gotStart.getTime()).toBe(start.getTime());
    expect(gotEnd.getTime()).toBe(end.getTime());
  });
});

describe("owner availability is scoped to the owner's own blocks", () => {
  // A co-host's reserved blocks carry a non-null coHostId. The public booking
  // page resolves the OWNER's availability, so it must query only owner blocks
  // (coHostId=null). Without this scope, a co-host reserving time would shrink
  // the owner's bookable window — the "someone else's data takes the booking
  // page down" failure class. See docs/REGRESSIONS.md.
  it("loads only personal blocks with coHostId=null", async () => {
    await getAvailability({
      requestedStart: new Date("2026-08-04T00:00:00Z"),
      requestedEnd: new Date("2026-08-11T00:00:00Z"),
      now: NOW,
    });
    expect(vi.mocked(prisma.personalBlock.findMany)).toHaveBeenCalledWith({
      where: { coHostId: null },
    });
  });
});

describe("timed actionables occupy the owner's time", () => {
  // Reported from production: a 4:30-5:30pm actionable sat on the owner's
  // agenda while /book advertised 4:30pm as free. Actionables are deliberately
  // not mirrored to a provider calendar, so they contributed no busy time at
  // all and every availability computation ignored them.
  const WINDOW = {
    requestedStart: new Date("2026-08-06T16:00:00Z"), // 9am PT
    requestedEnd: new Date("2026-08-07T02:00:00Z"), // 7pm PT
  };

  it("does not offer a slot covered by a timed actionable", async () => {
    vi.mocked(prisma.todo.findMany).mockResolvedValue([
      {
        startTime: new Date("2026-08-06T23:30:00Z"), // 4:30pm PT
        endTime: new Date("2026-08-07T00:30:00Z"), // 5:30pm PT
      },
    ] as never);

    const { slots } = await getAvailability({ ...WINDOW, durationMinutes: 30, now: NOW });
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).not.toContain("2026-08-06T23:30:00.000Z"); // 4:30pm
    expect(starts).not.toContain("2026-08-07T00:00:00.000Z"); // 5:00pm
    // The hour before it is untouched, so this blocks the commitment and not
    // the whole day.
    expect(starts).toContain("2026-08-06T22:30:00.000Z"); // 3:30pm
  });

  it("still offers that slot once the actionable is gone", async () => {
    const { slots } = await getAvailability({ ...WINDOW, durationMinutes: 30, now: NOW });
    expect(slots.map((s) => s.start.toISOString())).toContain("2026-08-06T23:30:00.000Z");
  });

  it("ignores untimed actionables, which occupy no particular time", async () => {
    // The query only returns rows with both ends set; an untimed checklist item
    // must never remove a slot.
    vi.mocked(prisma.todo.findMany).mockResolvedValue([] as never);
    const { slots } = await getAvailability({ ...WINDOW, durationMinutes: 30, now: NOW });
    expect(slots.length).toBeGreaterThan(0);
  });
});
