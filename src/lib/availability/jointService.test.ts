import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    personalBlock: { findMany: vi.fn() },
    todo: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/calendar/aggregate", () => ({ fanOutBusy: vi.fn() }));

import { getJointAvailability } from "./jointService";
import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";

const NOW = new Date("2026-08-06T12:00:00Z");
// A single owner-local working day window (9am-7pm PT).
const WINDOW = {
  requestedStart: new Date("2026-08-06T16:00:00Z"),
  requestedEnd: new Date("2026-08-07T02:00:00Z"),
};

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

describe("getJointAvailability", () => {
  it("fans out once per subject: the owner (null) AND each co-host", async () => {
    await getJointAvailability({ ...WINDOW, coHostIds: ["ben", "cara"], now: NOW });
    const subjects = vi.mocked(fanOutBusy).mock.calls.map((c) => c[2]);
    expect(subjects).toEqual([null, "ben", "cara"]);
  });

  it("scopes blocks to the owner and the listed co-hosts only", async () => {
    await getJointAvailability({ ...WINDOW, coHostIds: ["ben"], now: NOW });
    expect(vi.mocked(prisma.personalBlock.findMany)).toHaveBeenCalledWith({
      where: { OR: [{ coHostId: null }, { coHostId: { in: ["ben"] } }] },
    });
  });

  it("does NOT offer a slot when the CO-HOST is busy, even though the owner is free", async () => {
    // Owner free all day; Ben busy 4:30-5:30pm PT.
    vi.mocked(fanOutBusy).mockImplementation((_s, _e, id) =>
      Promise.resolve(
        id === "ben"
          ? { busy: [{ start: new Date("2026-08-06T23:30:00Z"), end: new Date("2026-08-07T00:30:00Z") }], errors: [] }
          : { busy: [], errors: [] }
      ) as never
    );

    const { slots } = await getJointAvailability({
      ...WINDOW,
      coHostIds: ["ben"],
      durationMinutes: 30,
      now: NOW,
    });
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).not.toContain("2026-08-06T23:30:00.000Z"); // 4:30 — Ben busy
    expect(starts).not.toContain("2026-08-07T00:00:00.000Z"); // 5:00 — Ben busy
    expect(starts).toContain("2026-08-06T22:30:00.000Z"); // 3:30 — both free
  });

  it("offers the slot once the co-host is free there too", async () => {
    const { slots } = await getJointAvailability({
      ...WINDOW,
      coHostIds: ["ben"],
      durationMinutes: 30,
      now: NOW,
    });
    expect(slots.map((s) => s.start.toISOString())).toContain("2026-08-06T23:30:00.000Z");
  });

  it("merges warnings from every member's fan-out", async () => {
    vi.mocked(fanOutBusy).mockImplementation((_s, _e, id) =>
      Promise.resolve(
        id === "ben"
          ? { busy: [], errors: [{ email: "ben@x.com", message: "token" }] }
          : { busy: [], errors: [] }
      ) as never
    );
    const { warnings } = await getJointAvailability({ ...WINDOW, coHostIds: ["ben"], now: NOW });
    expect(warnings).toEqual([{ email: "ben@x.com", message: "token" }]);
  });

  it("degrades to owner-only when there are no co-hosts", async () => {
    await getJointAvailability({ ...WINDOW, coHostIds: [], now: NOW });
    expect(vi.mocked(fanOutBusy).mock.calls.map((c) => c[2])).toEqual([null]);
  });

  it("deduplicates a co-host id passed twice", async () => {
    await getJointAvailability({ ...WINDOW, coHostIds: ["ben", "ben"], now: NOW });
    expect(vi.mocked(fanOutBusy).mock.calls.map((c) => c[2])).toEqual([null, "ben"]);
  });
});
