import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/nudge/service", () => ({
  createNudge: vi.fn(),
  listUpcomingNudges: vi.fn(),
  cancelNudge: vi.fn(),
}));

import { GET, POST } from "./route";
import { createNudge, listUpcomingNudges } from "@/lib/nudge/service";

function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.mocked(createNudge).mockReset();
  vi.mocked(listUpcomingNudges).mockReset();
});

describe("POST /api/reminders", () => {
  it("creates a reminder (201)", async () => {
    vi.mocked(createNudge).mockResolvedValue({ ok: true, id: "n1", whenLabel: "Mon Jul 20, 12:15 PM" });
    const res = await POST(jsonReq({ fireAtISO: "2026-07-20T19:15:00Z", message: "ping", event: { kind: "event", id: "e1", account: "a@x.com" } }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "n1" });
    expect(vi.mocked(createNudge).mock.calls[0][0]).toMatchObject({ fireAtISO: "2026-07-20T19:15:00Z", message: "ping" });
  });
  it("returns 400 when the service rejects", async () => {
    vi.mocked(createNudge).mockResolvedValue({ ok: false, error: "fire_time_in_past" });
    const res = await POST(jsonReq({ fireAtISO: "2020-01-01T00:00:00Z", message: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "fire_time_in_past" });
  });
  it("returns 400 on invalid JSON", async () => {
    const res = await POST({ json: async () => { throw new Error("bad"); } } as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reminders", () => {
  it("returns the upcoming reminders", async () => {
    vi.mocked(listUpcomingNudges).mockResolvedValue([{ id: "a", whenLabel: "w", body: "b", recurring: false, eventKind: null, eventId: null }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).reminders).toHaveLength(1);
  });
});
