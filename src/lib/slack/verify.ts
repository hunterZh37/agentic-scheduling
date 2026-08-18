import { createHmac, timingSafeEqual } from "crypto";
import { optionalEnv } from "@/lib/env";

// Slack signs every request with HMAC-SHA256 over "v0:<timestamp>:<raw body>".
// The RAW body matters: re-serialising the parsed JSON changes bytes (key
// order, spacing) and the signature stops matching, so the route must verify
// before it parses.

const VERSION = "v0";
/// Slack's own recommendation: reject anything older than five minutes so a
/// captured request can't be replayed later.
const MAX_SKEW_SECONDS = 60 * 5;

export interface SlackVerifyArgs {
  signingSecret: string;
  signature: string | null; // x-slack-signature
  timestamp: string | null; // x-slack-request-timestamp
  rawBody: string;
  nowSeconds?: number;
}

export function verifySlackSignature({
  signingSecret,
  signature,
  timestamp,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
}: SlackVerifyArgs): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const expected =
    `${VERSION}=` +
    createHmac("sha256", signingSecret)
      .update(`${VERSION}:${timestamp}:${rawBody}`, "utf8")
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch — guard so a wrong-length
  // signature is a clean false rather than an exception.
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Slack user IDs allowed to reach the PRIVATE agent (full calendar access).
///
/// Everyone else in a channel gets the public agent. This is the whole security
/// model of the Slack channel: unlike WhatsApp, where the sender is a single
/// phone number the owner controls, a Slack channel is multi-user and anyone in
/// it can address the bot. Returning an empty list must therefore mean "nobody
/// is the owner", never "everyone is".
export function ownerSlackUserIds(): string[] {
  return (optionalEnv("OWNER_SLACK_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/// Whether this Slack user may command the private agent. Fails closed.
export function isOwnerSlackUser(userId: string | undefined): boolean {
  if (!userId) return false;
  const allowed = ownerSlackUserIds();
  if (allowed.length === 0) return false;
  return allowed.includes(userId);
}
