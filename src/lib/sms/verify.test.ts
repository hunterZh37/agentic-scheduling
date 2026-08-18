import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  normalizePhone,
  isAuthorizedSender,
  twilioSignatureBase,
  verifyTwilioSignature,
} from "./verify";

// Reference signature the way Twilio computes it, so the "valid" test isn't
// just re-implementing the code under test with the same helper.
function sign(url: string, params: Record<string, string>, token: string): string {
  let acc = url;
  for (const key of Object.keys(params).sort()) acc += key + params[key];
  return createHmac("sha1", token).update(acc, "utf-8").digest("base64");
}

describe("normalizePhone", () => {
  it("strips formatting but keeps a leading +", () => {
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("+1-415-555-0100")).toBe("+14155550100");
  });

  it("keeps digits without a + when none is given", () => {
    expect(normalizePhone("415.555.0100")).toBe("4155550100");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePhone("  +14155550100  ")).toBe("+14155550100");
  });
});

describe("isAuthorizedSender", () => {
  it("matches across formatting differences", () => {
    expect(isAuthorizedSender("+1 (415) 555-0100", "+14155550100")).toBe(true);
  });

  it("rejects a different number", () => {
    expect(isAuthorizedSender("+14155550199", "+14155550100")).toBe(false);
  });

  it("rejects an empty sender even against an empty allowlist entry", () => {
    expect(isAuthorizedSender("", "")).toBe(false);
  });
});

describe("twilioSignatureBase", () => {
  it("appends params sorted by key with no separators", () => {
    const base = twilioSignatureBase("https://x.test/hook", { b: "2", a: "1" });
    expect(base).toBe("https://x.test/hooka1b2");
  });
});

describe("verifyTwilioSignature", () => {
  const token = "test_auth_token";
  const url = "https://app.example.com/api/sms/inbound";
  const params = { From: "+14155550100", Body: "hi there", To: "+14155550111" };

  it("accepts a correctly-signed request", () => {
    const signature = sign(url, params, token);
    expect(verifyTwilioSignature({ url, params, signature, authToken: token })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(url, params, token);
    const tampered = { ...params, Body: "transfer everything" };
    expect(
      verifyTwilioSignature({ url, params: tampered, signature, authToken: token })
    ).toBe(false);
  });

  it("rejects a wrong auth token", () => {
    const signature = sign(url, params, token);
    expect(
      verifyTwilioSignature({ url, params, signature, authToken: "wrong_token" })
    ).toBe(false);
  });

  it("rejects a mismatched (wrong-length) signature without throwing", () => {
    expect(
      verifyTwilioSignature({ url, params, signature: "short", authToken: token })
    ).toBe(false);
  });

  it("rejects when the signed URL differs (tunnel/proxy host mismatch)", () => {
    const signature = sign("https://other.example.com/api/sms/inbound", params, token);
    expect(verifyTwilioSignature({ url, params, signature, authToken: token })).toBe(false);
  });
});
