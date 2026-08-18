import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/availability/service", () => ({ getAvailability: vi.fn() }));
vi.mock("@/lib/agent/rateLimit", () => ({ checkMessageAllowed: vi.fn(() => ({ ok: true })) }));

import { POST } from "./route";
import { getAvailability } from "@/lib/availability/service";
import { checkMessageAllowed } from "@/lib/agent/rateLimit";

const d = (iso: string) => new Date(iso);

function mockReq(body: unknown, ip = "1.2.3.4"): NextRequest {
  return {
    headers: new Headers({ "x-forwarded-for": ip }),
    json: async () => body,
  } as unknown as NextRequest;
}

const validBody = () => ({
  requesterName: "Ada Lovelace",
  requesterEmail: "ada@example.com",
  durationMinutes: 30,
  window: { startISO: "2026-07-20T00:00:00Z", endISO: "2026-07-22T00:00:00Z" },
  requesterFreeSlots: [{ startISO: "2026-07-20T17:00:00Z", endISO: "2026-07-20T21:00:00Z" }],
  timezone: "America/New_York",
});

beforeEach(() => {
  vi.mocked(checkMessageAllowed).mockReturnValue({ ok: true });
  vi.mocked(getAvailability).mockResolvedValue({
    slots: [
      { start: d("2026-07-20T18:00:00Z"), end: d("2026-07-20T18:30:00Z") },
      { start: d("2026-07-20T23:00:00Z"), end: d("2026-07-20T23:30:00Z") },
    ],
    warnings: [],
  });
});

describe("POST /api/agent/negotiate", () => {
  it("returns the mutual slots between host availability and requester windows", async () => {
    const res = await POST(mockReq(validBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hostTimezone).toBeTruthy();
    expect(json.mutualSlots).toEqual([
      { startISO: "2026-07-20T18:00:00.000Z", endISO: "2026-07-20T18:30:00.000Z" },
    ]);
    expect(json.partial).toBe(false);
    expect(vi.mocked(getAvailability)).toHaveBeenCalledWith({
      requestedStart: d("2026-07-20T00:00:00Z"),
      requestedEnd: d("2026-07-22T00:00:00Z"),
      durationMinutes: 30,
    });
  });

  it("sanitizes availability warnings — no account emails leak", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      slots: [{ start: d("2026-07-20T18:00:00Z"), end: d("2026-07-20T18:30:00Z") }],
      warnings: [{ email: "owner@example.com", message: "Google events.list failed: 403 ..." }],
    });
    const res = await POST(mockReq(validBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.partial).toBe(true);
    expect(json.warnings).toEqual([{ code: "account_unavailable" }]);
    expect(JSON.stringify(json)).not.toContain("owner@example.com");
  });

  it("returns 400 on invalid input", async () => {
    const res = await POST(mockReq({ ...validBody(), requesterEmail: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_email");
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkMessageAllowed).mockReturnValue({ ok: false, reason: "message_limit" });
    const res = await POST(mockReq(validBody()));
    expect(res.status).toBe(429);
  });
});
