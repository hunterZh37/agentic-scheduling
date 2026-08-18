import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/availability/service", () => ({ getAvailability: vi.fn() }));

import { computeMutualSlots, runFindMutualTimes } from "./mutualSlots";
import { getAvailability } from "@/lib/availability/service";

const d = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.mocked(getAvailability).mockReset();
});

describe("computeMutualSlots", () => {
  it("intersects host availability with the requester's free windows", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      slots: [
        { start: d("2026-07-20T18:00:00Z"), end: d("2026-07-20T18:30:00Z") },
        { start: d("2026-07-20T23:00:00Z"), end: d("2026-07-20T23:30:00Z") },
      ],
      warnings: [],
    });
    const res = await computeMutualSlots({
      windowStart: d("2026-07-20T00:00:00Z"),
      windowEnd: d("2026-07-21T00:00:00Z"),
      durationMinutes: 30,
      requesterFree: [{ start: d("2026-07-20T17:00:00Z"), end: d("2026-07-20T21:00:00Z") }],
    });
    expect(res.mutualSlots.map((s) => s.start.toISOString())).toEqual([
      "2026-07-20T18:00:00.000Z",
    ]);
    expect(res.warnings).toEqual([]);
    expect(vi.mocked(getAvailability)).toHaveBeenCalledWith({
      requestedStart: d("2026-07-20T00:00:00Z"),
      requestedEnd: d("2026-07-21T00:00:00Z"),
      durationMinutes: 30,
      now: undefined,
    });
  });

  it("sanitizes warnings to a generic code (no account emails)", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      slots: [],
      warnings: [{ email: "owner@example.com", message: "Google 403 ..." }],
    });
    const res = await computeMutualSlots({
      windowStart: d("2026-07-20T00:00:00Z"),
      windowEnd: d("2026-07-21T00:00:00Z"),
      durationMinutes: 30,
      requesterFree: [],
    });
    expect(res.warnings).toEqual([{ code: "account_unavailable" }]);
    expect(JSON.stringify(res)).not.toContain("owner@example.com");
  });
});

describe("runFindMutualTimes", () => {
  it("parses ISO input, calls the core, and returns tool JSON", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      slots: [{ start: d("2026-07-20T18:00:00Z"), end: d("2026-07-20T18:30:00Z") }],
      warnings: [],
    });
    const out = JSON.parse(
      await runFindMutualTimes({
        durationMinutes: 30,
        windowStartISO: "2026-07-20T00:00:00Z",
        windowEndISO: "2026-07-21T00:00:00Z",
        requesterFreeSlots: [{ startISO: "2026-07-20T17:00:00Z", endISO: "2026-07-20T21:00:00Z" }],
        requesterTimezone: "America/New_York",
      })
    );
    expect(out.mutualSlots).toEqual([
      { startISO: "2026-07-20T18:00:00.000Z", endISO: "2026-07-20T18:30:00.000Z" },
    ]);
    expect(out.hostTimezone).toBeTruthy();
    expect(out.partial).toBe(false);
  });

  it("drops malformed requester slots without throwing", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      slots: [{ start: d("2026-07-20T18:00:00Z"), end: d("2026-07-20T18:30:00Z") }],
      warnings: [],
    });
    const out = JSON.parse(
      await runFindMutualTimes({
        durationMinutes: 30,
        windowStartISO: "2026-07-20T00:00:00Z",
        windowEndISO: "2026-07-21T00:00:00Z",
        requesterFreeSlots: [
          { startISO: "not-a-date", endISO: "2026-07-20T21:00:00Z" },
          { startISO: "2026-07-20T17:00:00Z", endISO: "2026-07-20T21:00:00Z" },
        ],
        requesterTimezone: "UTC",
      })
    );
    expect(out.mutualSlots).toHaveLength(1);
  });
});
