import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/agent/run", () => ({ runRequesterAgent: vi.fn() }));
vi.mock("@/lib/agent/rateLimit", () => ({
  checkMessageAllowed: vi.fn(() => ({ ok: true })),
  tryReserveBooking: vi.fn(() => true),
  releaseBooking: vi.fn(),
}));

import { POST } from "./route";
import { runRequesterAgent } from "@/lib/agent/run";
import { checkMessageAllowed } from "@/lib/agent/rateLimit";

function mockReq(body: unknown, ip = "1.2.3.4"): NextRequest {
  return {
    headers: new Headers({ "x-forwarded-for": ip }),
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.mocked(checkMessageAllowed).mockReturnValue({ ok: true });
  vi.mocked(runRequesterAgent).mockResolvedValue("Here are some times that work…");
});

describe("POST /api/agent/requester", () => {
  it("runs the requester agent and returns its reply", async () => {
    const res = await POST(mockReq({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe("Here are some times that work…");
  });

  it("returns 400 when there are no messages", async () => {
    const res = await POST(mockReq({ sessionId: "s1", messages: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkMessageAllowed).mockReturnValue({ ok: false, reason: "message_limit" });
    const res = await POST(mockReq({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(429);
  });
});
