import { describe, it, expect } from "vitest";
import {
  makeSessionToken,
  verifySessionToken,
  passwordMatches,
  sessionNeedsRenewal,
  sessionExpirySeconds,
  SESSION_TTL_SECONDS,
  SESSION_RENEW_AFTER_SECONDS,
} from "./session";

const SECRET = "test-secret-value-123";
const NOW = 1_700_000_000;

describe("session tokens", () => {
  it("mints a token that verifies with the same secret before expiry", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(await verifySessionToken(SECRET, token, NOW + 60)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(await verifySessionToken("other-secret", token, NOW + 60)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    // One second past the TTL window.
    expect(await verifySessionToken(SECRET, token, NOW + SESSION_TTL_SECONDS + 1)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    const [exp] = token.split(".");
    const tampered = `${exp}.${"0".repeat(64)}`;
    expect(await verifySessionToken(SECRET, tampered, NOW + 60)).toBe(false);
  });

  it("rejects a tampered expiry (extending lifetime)", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    const sig = token.split(".")[1];
    const forged = `${NOW + SESSION_TTL_SECONDS * 10}.${sig}`;
    expect(await verifySessionToken(SECRET, forged, NOW + 60)).toBe(false);
  });

  it("rejects undefined / malformed tokens", async () => {
    expect(await verifySessionToken(SECRET, undefined, NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, "", NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, "no-dot", NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, ".abc", NOW)).toBe(false);
  });
});

describe("sliding session renewal", () => {
  it("reads the expiry out of a well-formed token", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(sessionExpirySeconds(token)).toBe(NOW + SESSION_TTL_SECONDS);
  });

  it("returns null expiry for missing/malformed tokens", () => {
    expect(sessionExpirySeconds(undefined)).toBeNull();
    expect(sessionExpirySeconds("")).toBeNull();
    expect(sessionExpirySeconds(".abc")).toBeNull();
    expect(sessionExpirySeconds("notanumber.sig")).toBeNull();
  });

  it("does NOT renew a fresh token", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(sessionNeedsRenewal(token, NOW + 60)).toBe(false);
  });

  it("does NOT renew right up to the halfway point", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(sessionNeedsRenewal(token, NOW + SESSION_RENEW_AFTER_SECONDS - 1)).toBe(false);
  });

  it("renews once past the halfway point", async () => {
    const token = await makeSessionToken(SECRET, NOW);
    expect(sessionNeedsRenewal(token, NOW + SESSION_RENEW_AFTER_SECONDS)).toBe(true);
    expect(sessionNeedsRenewal(token, NOW + SESSION_TTL_SECONDS - 1)).toBe(true);
  });

  it("does not renew a malformed token", () => {
    expect(sessionNeedsRenewal(undefined, NOW)).toBe(false);
    expect(sessionNeedsRenewal("garbage", NOW)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("is true only for an exact match", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(passwordMatches("short", "longerpassword")).toBe(false);
    expect(passwordMatches("", "")).toBe(true);
  });
});
