import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const env: Record<string, string | undefined> = {
  CRON_SECRET: "testsecret",
  MONITOR_PREVIEW_TOKEN: "previewtok",
  OWNER_WHATSAPP_NUMBER: "+15550004242",
  TWILIO_WHATSAPP_FROM: "whatsapp:+15559915614",
  OWNER_EMAIL: "owner@example.com",
};

vi.mock("@/lib/env", () => ({
  PUBLIC_BASE_URL: "https://test.example",
  optionalEnv: (k: string) => env[k],
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    account: { count: vi.fn().mockResolvedValue(3) },
    // The cold-start warmup pings the DB before any check runs.
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
  },
}));
vi.mock("@/lib/sms/send", () => ({ sendTwilioMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notify/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  // contact.ts imports this; without it the whole module graph fails to load.
  isUnroutable: vi.fn(() => false),
}));
// The monitor now runs the messaging checks. Stub them: this suite is about the
// monitor's alerting, and the checks have their own tests in
// src/lib/notify/health.test.ts.
vi.mock("@/lib/notify/health", () => ({
  checkMessaging: vi.fn(async () => ({ ok: true, checks: [] })),
}));

import { GET } from "./route";
import { sendTwilioMessage } from "@/lib/sms/send";
import { sendEmail } from "@/lib/notify/email";

function req(auth = "Bearer testsecret", query = ""): NextRequest {
  return new Request(`https://test.example/api/cron/monitor${query}`, {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as NextRequest;
}

// Healthy responses for every page/API the monitor checks.
function healthyFetch(bookBody = "<h1>Book time with Hunter</h1>") {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/availability")) {
      return { status: 200, json: async () => ({ slots: [{ start: "x", end: "y" }] }) };
    }
    if (u.endsWith("/book")) return { status: 200, text: async () => bookBody };
    return { status: 200, text: async () => "ok" };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.mocked(sendTwilioMessage).mockClear();
  vi.mocked(sendEmail).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/cron/monitor", () => {
  it("rejects a request without the cron secret (401)", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const res = await GET(req(""));
    expect(res.status).toBe(401);
  });

  it("passes and sends NO alert when everything is healthy", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(sendTwilioMessage).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("alerts (WhatsApp + email) when /book shows the placeholder name instead of Hunter", async () => {
    vi.stubGlobal("fetch", healthyFetch("<h1>Book time with Alex</h1>"));
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(false);
    const bookCheck = body.checks.find((c: { name: string }) => c.name === "book");
    expect(bookCheck.ok).toBe(false);
    expect(sendTwilioMessage).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The alert lists EVERY feature checked (pass or fail), not only the failure.
    const emailBody = String(vi.mocked(sendEmail).mock.calls[0][2]);
    for (const label of [
      "Public booking page",
      "Privacy Policy page",
      "Terms of Service page",
      "Assistant page",
      "Availability API",
      "Database",
    ]) {
      expect(emailBody).toContain(label);
    }
    expect(emailBody).toContain("Next check:");
  });

  it("authorizes a preview via ?token= (no bearer needed) and sends the sample", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const res = await GET(req("", "?preview=1&token=previewtok"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview).toBe(true);
    expect(sendTwilioMessage).toHaveBeenCalledTimes(1);
  });

  it("preview mode sends a sample alert even when all checks pass", async () => {
    vi.stubGlobal("fetch", healthyFetch());
    const res = await GET(req("Bearer testsecret", "?preview=1"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview).toBe(true);
    expect(sendTwilioMessage).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = String(vi.mocked(sendTwilioMessage).mock.calls[0][2]);
    expect(msg).toContain("PREVIEW");
    expect(msg).toContain("Next check:");
  });

  it("alerts when a page is down (non-200)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/privacy")) return { status: 500, text: async () => "err" };
        if (String(url).includes("/api/availability")) return { status: 200, json: async () => ({ slots: [] }) };
        if (String(url).endsWith("/book")) return { status: 200, text: async () => "Book time with Hunter" };
        return { status: 200, text: async () => "ok" };
      }) as unknown as typeof fetch
    );
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.find((c: { name: string }) => c.name === "privacy").ok).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
