import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/availability/service", () => ({ getAvailability: vi.fn() }));

import { DateTime } from "luxon";
import { getAvailabilityTool } from "./tools";
import { getAvailability } from "@/lib/availability/service";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

// The assistant reported "just one opening this Thursday afternoon" while the
// booking page listed eight that day, and answered the SAME question differently
// on a re-run. The cause was the model narrowing the query to its own guess at
// "afternoon", which made every later slot invisible to it.
//
// partitionSlots is unit-tested separately, but on its own it guarantees nothing:
// reverting the day-widening would leave those tests green while the bug came
// straight back. This asserts the behaviour that actually matters — the tool
// searches the whole day whatever window it is handed, and hands back both
// buckets.

const iso = (d: Date) => d.toISOString();

/// Run the tool the way the SDK would.
const runTool = async (args: Record<string, unknown>) => {
  const tool = getAvailabilityTool() as unknown as {
    run: (a: Record<string, unknown>) => Promise<string>;
  };
  return JSON.parse(await tool.run(args));
};

beforeEach(() => {
  vi.mocked(getAvailability).mockReset().mockResolvedValue({ slots: [], warnings: [] } as never);
});

describe("get_availability always searches the whole day", () => {
  it("widens a narrow afternoon window to the full owner-local day", async () => {
    // Noon–5pm PT on Thu Aug 6 == 19:00–00:00 UTC.
    await runTool({
      startISO: "2026-08-06T19:00:00.000Z",
      endISO: "2026-08-07T00:00:00.000Z",
    });

    const call = vi.mocked(getAvailability).mock.calls[0][0];
    const queried =
      (call.requestedEnd.getTime() - call.requestedStart.getTime()) / 3_600_000;
    // A whole local day, not the five hours asked for.
    expect(queried).toBeGreaterThan(23);
    // Local midnight of that day, whatever the owner's zone is — derived, not
    // hardcoded, so the test travels with OWNER_TIMEZONE.
    const localMidnight = DateTime.fromISO("2026-08-06T19:00:00.000Z")
      .setZone(OWNER_TIMEZONE)
      .startOf("day")
      .toUTC()
      .toISO();
    expect(iso(call.requestedStart)).toBe(localMidnight);
  });

  it("returns both buckets, so later slots are never invisible", async () => {
    const at = (h: number, m = 0) => ({
      start: new Date(Date.UTC(2026, 7, 6, h, m)),
      end: new Date(Date.UTC(2026, 7, 6, h, m + 30)),
    });
    vi.mocked(getAvailability).mockResolvedValue({
      // 9am, 4pm (inside the window), then 5:30pm and 6pm (outside it).
      slots: [at(16), at(23), at(24 % 24, 30), { start: new Date(Date.UTC(2026, 7, 7, 1)), end: new Date(Date.UTC(2026, 7, 7, 1, 30)) }],
      warnings: [],
    } as never);

    const out = await runTool({
      startISO: "2026-08-06T19:00:00.000Z",
      endISO: "2026-08-07T00:00:00.000Z",
    });

    expect(out).toHaveProperty("matching");
    expect(out).toHaveProperty("alsoFreeSameDay");
    // The regression in one line: something free that day, outside the phrasing,
    // still reaches the model.
    expect(out.alsoFreeSameDay.length).toBeGreaterThan(0);
    expect(out.matching.length + out.alsoFreeSameDay.length).toBe(4);
  });

  it("never returns a bare `slots` list again", async () => {
    // The old shape let the model present whatever it had queried as if it were
    // the whole picture.
    const out = await runTool({
      startISO: "2026-08-06T19:00:00.000Z",
      endISO: "2026-08-07T00:00:00.000Z",
    });
    expect(out).not.toHaveProperty("slots");
  });

  it("rejects an unparseable range instead of querying a garbage window", async () => {
    const out = await runTool({ startISO: "not-a-date", endISO: "also-not" });
    expect(out.error).toBe("invalid_range");
    expect(getAvailability).not.toHaveBeenCalled();
  });
});
