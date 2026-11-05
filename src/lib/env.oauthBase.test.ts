import { describe, it, expect, vi, afterEach } from "vitest";

// A sign-in link must point at the host whose login callback Google knows and
// where the dashboard is used, which since 2026-10-07 is not the public
// booking host (an alias domain that corporate web filters do not block). It
// is an explicit setting: the legacy GOOGLE_OAUTH_REDIRECT_URI must NOT be
// used for this. Production still has it set to the vercel.app deployment
// domain, and that is exactly where a session cookie must not end up. (Since
// 2026-11-04 nothing reads that variable at all: see oauth/redirect.ts.)

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OAUTH_BASE_URL", () => {
  it("is AUTH_BASE_URL when set, whatever the Google redirect URI says", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://book.hunterzhangconsulting.com");
    vi.stubEnv("AUTH_BASE_URL", "https://bookwithhunter.com");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://agentic-scheduling-abc.vercel.app/api/oauth/google/callback");
    const env = await import("./env");
    expect(env.OAUTH_BASE_URL).toBe("https://bookwithhunter.com");
    expect(env.PUBLIC_HOST).toBe("book.hunterzhangconsulting.com");
  });
  it("falls back to the public base when AUTH_BASE_URL is not set", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://book.hunterzhangconsulting.com");
    vi.stubEnv("AUTH_BASE_URL", "");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://agentic-scheduling-abc.vercel.app/api/oauth/google/callback");
    expect((await import("./env")).OAUTH_BASE_URL).toBe("https://book.hunterzhangconsulting.com");
  });
});
