import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio inbound-webhook security primitives, kept as pure functions so they
// can be unit-tested without a live request. Two independent gates protect the
// agent: a valid Twilio signature (the request really came from Twilio) AND a
// sender allowlist (the request came from the owner's phone).

/// Normalize a phone number to bare-E.164-ish form for comparison: keep a
/// leading '+' and the digits, drop spaces, dashes, parens, and dots. This is
/// comparison-only — we never dial the result, so we don't reformat, just
/// canonicalize enough that "+1 (415) 555-0100" and "+14155550100" match.
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/// Whether the inbound sender is the one authorized number. Both sides are
/// normalized first so formatting differences never cause a false reject.
export function isAuthorizedSender(from: string, authorized: string): boolean {
  const a = normalizePhone(from);
  const b = normalizePhone(authorized);
  return a.length > 0 && a === b;
}

/// Rebuild the exact string Twilio signed: the full request URL followed by
/// every POST parameter, sorted by key, concatenated as key+value (no
/// separators). Exported for testing.
export function twilioSignatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let acc = url;
  for (const key of keys) acc += key + params[key];
  return acc;
}

interface VerifyArgs {
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}

/// Validate an X-Twilio-Signature: HMAC-SHA1 over (url + sorted params) keyed
/// by the auth token, base64-encoded, timing-safe compared to the header. The
/// `url` must be the public URL Twilio was configured with (build it from
/// APP_BASE_URL, not req.url, which is internal behind a tunnel/proxy).
export function verifyTwilioSignature({ url, params, signature, authToken }: VerifyArgs): boolean {
  const expected = createHmac("sha1", authToken)
    .update(Buffer.from(twilioSignatureBase(url, params), "utf-8"))
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length
  // signature is a clean `false`, not an exception.
  return a.length === b.length && timingSafeEqual(a, b);
}
