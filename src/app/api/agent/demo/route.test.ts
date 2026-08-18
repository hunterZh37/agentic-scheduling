import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/agent/negotiationDemo", () => ({ runNegotiation: vi.fn() }));
vi.mock("@/lib/agent/rateLimit", () => ({ checkDemoAllowed: vi.fn(() => ({ ok: true })) }));

import { GET } from "./route";
import { runNegotiation } from "@/lib/agent/negotiationDemo";
import { checkDemoAllowed } from "@/lib/agent/rateLimit";

function mockReq(ip = "1.2.3.4"): NextRequest {
  return { headers: new Headers({ "x-forwarded-for": ip }) } as unknown as NextRequest;
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

beforeEach(() => {
  vi.mocked(checkDemoAllowed).mockReturnValue({ ok: true });
  vi.mocked(runNegotiation).mockReset();
});

describe("GET /api/agent/demo", () => {
  it("streams the negotiation events as SSE frames", async () => {
    vi.mocked(runNegotiation).mockImplementation(async (persona, emit) => {
      emit({ type: "persona", persona });
      emit({ type: "message", agent: "B", text: "hi" });
      emit({ type: "result", startISO: "2026-07-21T18:00:00Z", endISO: "2026-07-21T18:30:00Z" });
      emit({ type: "done" });
    });
    const res = await GET(mockReq());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await readAll(res);
    expect(body).toContain('data: {"type":"persona"');
    expect(body).toContain('"type":"message"');
    expect(body).toContain('"type":"result"');
    expect(body).toContain('"type":"done"');
  });

  it("streams an error event and skips the negotiation when rate limited", async () => {
    vi.mocked(checkDemoAllowed).mockReturnValue({ ok: false, reason: "message_limit" });
    const res = await GET(mockReq());
    const body = await readAll(res);
    expect(body).toContain('"type":"error"');
    expect(vi.mocked(runNegotiation)).not.toHaveBeenCalled();
  });
});
