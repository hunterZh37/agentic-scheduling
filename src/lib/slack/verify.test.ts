import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));

import { verifySlackSignature, isOwnerSlackUser, ownerSlackUserIds } from "./verify";
import { optionalEnv } from "@/lib/env";

const SECRET = "s3cr3t";
const sign = (body: string, ts: string, secret = SECRET) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`, "utf8").digest("hex");

beforeEach(() => {
  vi.mocked(optionalEnv).mockReset().mockReturnValue(undefined);
});

describe("verifySlackSignature", () => {
  const body = '{"type":"event_callback"}';
  const now = 1_770_000_000;
  const ts = String(now);

  it("accepts a correctly signed request", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(body, ts),
        timestamp: ts,
        rawBody: body,
        nowSeconds: now,
      })
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(body, ts, "wrong"),
        timestamp: ts,
        rawBody: body,
        nowSeconds: now,
      })
    ).toBe(false);
  });

  // The signature covers the RAW bytes. Re-serialising parsed JSON reorders
  // keys and changes spacing, so verifying after a parse round-trip fails.
  it("rejects when the body differs by even one byte", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(body, ts),
        timestamp: ts,
        rawBody: '{"type":"event_callback" }',
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects a replay of an old but validly signed request", () => {
    const old = String(now - 60 * 10);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(body, old),
        timestamp: old,
        rawBody: body,
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects missing or malformed headers without throwing", () => {
    const base = { signingSecret: SECRET, rawBody: body, nowSeconds: now };
    expect(verifySlackSignature({ ...base, signature: null, timestamp: ts })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: sign(body, ts), timestamp: null })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: "v0=short", timestamp: ts })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: sign(body, ts), timestamp: "nonsense" })).toBe(false);
  });
});

// A Slack channel is multi-user, unlike the single phone number on WhatsApp.
// The private agent can read the whole calendar and cancel meetings, so an
// unset allowlist must mean nobody — never everybody in the channel.
describe("isOwnerSlackUser", () => {
  it("denies everyone when no allowlist is configured", () => {
    expect(isOwnerSlackUser("U123")).toBe(false);
    expect(ownerSlackUserIds()).toEqual([]);
  });

  it("denies an unknown user when an allowlist exists", () => {
    vi.mocked(optionalEnv).mockReturnValue("U_OWNER");
    expect(isOwnerSlackUser("U_STRANGER")).toBe(false);
  });

  it("allows a listed user", () => {
    vi.mocked(optionalEnv).mockReturnValue("U_OWNER, U_SECOND");
    expect(isOwnerSlackUser("U_OWNER")).toBe(true);
    expect(isOwnerSlackUser("U_SECOND")).toBe(true);
  });

  it("denies an absent user id", () => {
    vi.mocked(optionalEnv).mockReturnValue("U_OWNER");
    expect(isOwnerSlackUser(undefined)).toBe(false);
  });
});
