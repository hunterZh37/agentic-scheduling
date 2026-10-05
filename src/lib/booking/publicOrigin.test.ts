import { describe, it, expect, beforeEach, vi } from "vitest";

// Links sent to a visitor must stay on the host they booked from, when that host
// is one of ours; anything else falls back to the primary domain. A visitor on a
// filtered network reached us on the alias precisely because the primary host is
// blocked for them, so a manage link on the primary host would be dead on
// arrival (docs/REGRESSIONS.md #67).

vi.mock("@/lib/env", () => ({
  PUBLIC_BASE_URL: "https://bookwithhunter.com",
  optionalEnv: (k: string) => (process.env[k] && process.env[k]!.length > 0 ? process.env[k] : undefined),
}));

import { publicOrigin } from "./publicOrigin";

describe("publicOrigin", () => {
  beforeEach(() => {
    process.env.PUBLIC_ALIAS_HOSTS = "book.hunterzhangconsulting.com, Other.Example.com";
  });

  it("no host: primary", () => {
    expect(publicOrigin(null)).toBe("https://bookwithhunter.com");
    expect(publicOrigin("")).toBe("https://bookwithhunter.com");
  });
  it("the primary host stays the primary origin", () => {
    expect(publicOrigin("bookwithhunter.com")).toBe("https://bookwithhunter.com");
  });
  it("a configured alias is honoured, case-insensitively, always https", () => {
    expect(publicOrigin("book.hunterzhangconsulting.com")).toBe("https://book.hunterzhangconsulting.com");
    expect(publicOrigin("other.example.com")).toBe("https://other.example.com");
  });
  it("an unknown or forged host falls back to the primary", () => {
    expect(publicOrigin("evil.example")).toBe("https://bookwithhunter.com");
    expect(publicOrigin("bookwithhunter.com.evil.example")).toBe("https://bookwithhunter.com");
  });
  it("no aliases configured: only the primary", () => {
    delete process.env.PUBLIC_ALIAS_HOSTS;
    expect(publicOrigin("book.hunterzhangconsulting.com")).toBe("https://bookwithhunter.com");
  });
});
