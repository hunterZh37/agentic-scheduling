import { describe, it, expect, vi, afterEach } from "vitest";

// A sign-in link must point at the host whose OAuth callback Google knows,
// which since 2026-10-07 is not the public booking host (an alias domain that
// corporate web filters do not block). Derive it from the registered redirect
// URI, so no second "where does login live" setting can drift.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OAUTH_BASE_URL", () => {
  it("is the origin of the registered Google redirect URI", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://book.hunterzhangconsulting.com");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://bookwithhunter.com/api/oauth/google/callback");
    const env = await import("./env");
    expect(env.OAUTH_BASE_URL).toBe("https://bookwithhunter.com");
    expect(env.PUBLIC_HOST).toBe("book.hunterzhangconsulting.com");
  });
  it("falls back to the public base when no redirect URI is set or it is malformed", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://book.hunterzhangconsulting.com");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "");
    expect((await import("./env")).OAUTH_BASE_URL).toBe("https://book.hunterzhangconsulting.com");
    vi.resetModules();
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "not a url");
    expect((await import("./env")).OAUTH_BASE_URL).toBe("https://book.hunterzhangconsulting.com");
  });
});
