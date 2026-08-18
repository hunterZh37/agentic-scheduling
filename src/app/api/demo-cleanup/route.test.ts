import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/agent/demoBooking", () => ({ cleanupDemoBookings: vi.fn() }));

import { POST } from "./route";
import { cleanupDemoBookings } from "@/lib/agent/demoBooking";

describe("POST /api/demo-cleanup", () => {
  it("returns the number of demo bookings cleared", async () => {
    vi.mocked(cleanupDemoBookings).mockResolvedValue({ deleted: 3 });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });
  });
});
