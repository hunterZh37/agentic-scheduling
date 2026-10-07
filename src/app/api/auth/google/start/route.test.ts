import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/ownerLogin", () => ({ allowedLoginEmails: vi.fn(async () => ["owner@example.com"]) }));
vi.mock("@/lib/env", () => ({
  OAUTH_BASE_URL: "https://bookwithhunter.com",
  optionalEnv: (k: string) => process.env[k],
  requireEnv: (k: string) => process.env[k] ?? "",
}));

import { GET } from "./route";

// Google accepts only the redirect URI registered with it, and the login flow
// pins that URI to the host the request arrives on. Since 2026-10-07 the
// public booking host is a different domain from the OAuth host, so starting
// sign-in anywhere but the OAuth host must hop there first, not hand Google a
// URI it will refuse (redirect_uri_mismatch).

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client";
});

describe("sign-in start", () => {
  it("on the OAuth host: sends the owner to Google with a callback on that host", async () => {
    const res = await GET(new NextRequest("https://bookwithhunter.com/api/auth/google/start"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.hostname).toBe("accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://bookwithhunter.com/api/oauth/google/callback");
  });

  it("on the public booking host: hops to the OAuth host first", async () => {
    const res = await GET(new NextRequest("https://book.hunterzhangconsulting.com/api/auth/google/start"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://bookwithhunter.com/api/auth/google/start");
  });

  it("on a deployment domain: the same hop", async () => {
    const res = await GET(new NextRequest("https://agentic-scheduling-abc.vercel.app/api/auth/google/start"));
    expect(res.headers.get("location")).toBe("https://bookwithhunter.com/api/auth/google/start");
  });
});
