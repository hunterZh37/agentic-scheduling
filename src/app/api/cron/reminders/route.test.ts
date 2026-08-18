import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/notify/worker", () => ({ processDueReminders: vi.fn() }));
vi.mock("@/lib/nudge/worker", () => ({ processDueNudges: vi.fn() }));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn(() => undefined) })); // no CRON_SECRET in test

import { GET } from "./route";
import { processDueReminders } from "@/lib/notify/worker";
import { processDueNudges } from "@/lib/nudge/worker";

function req(): NextRequest {
  return { headers: new Headers() } as unknown as NextRequest;
}

beforeEach(() => {
  vi.mocked(processDueReminders).mockReset().mockResolvedValue({ processed: 0, sent: 0, failed: 0, skipped: 0, deadLettered: 0, errors: [] } as never);
  vi.mocked(processDueNudges).mockReset().mockResolvedValue({ processed: 1, sent: 1, failed: 0, rearmed: 0, deadLettered: 0, errors: [] } as never);
});

describe("GET /api/cron/reminders", () => {
  it("runs both the reminder and nudge workers and returns both results", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reminders).toBeTruthy();
    expect(body.nudges).toMatchObject({ sent: 1 });
    expect(vi.mocked(processDueReminders)).toHaveBeenCalledOnce();
    expect(vi.mocked(processDueNudges)).toHaveBeenCalledOnce();
  });

  it("still returns 200 with the reminders result when the nudge worker throws", async () => {
    vi.mocked(processDueNudges).mockRejectedValue(new Error("nudge worker exploded"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reminders).toBeTruthy(); // reminders result NOT discarded
    expect(body.nudges).toHaveProperty("error");
  });
});
