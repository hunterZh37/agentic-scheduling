import { optionalEnv, requireEnv, APP_BASE_URL } from "@/lib/env";

// Outbound Twilio REST send, used when a reply needs to go out *after* the
// inbound webhook has already responded (see src/app/api/sms/inbound). TwiML
// replies only work while the webhook connection is still open; once we've
// acked, this is the only way to deliver a message back to the sender.

// WhatsApp delivery can fail asynchronously (e.g. error 63112 on an unverified
// Business account) *after* the send API returns 201, so we ask Twilio to
// report each status transition to /api/sms/status, which resends failed
// WhatsApp messages as plain SMS. Only wired when APP_BASE_URL is a real https
// host Twilio can reach (skipped for localhost dev).
function statusCallbackUrl(params?: Record<string, string>): string | null {
  if (!APP_BASE_URL.startsWith("https://")) return null;
  const url = new URL(`${APP_BASE_URL}/api/sms/status`);
  // Correlation rides on the callback URL because Twilio echoes it back
  // verbatim. The alternative — storing the MessageSid on the row — needs a
  // migration, and migrations here are manual.
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/// Twilio addresses WhatsApp as "whatsapp:+E164". Accepts either form so a
/// number configured with or without the prefix works.
export function whatsappAddress(num: string): string {
  const n = num.trim();
  return n.startsWith("whatsapp:") ? n : `whatsapp:${n}`;
}

/// Send a message via the Twilio REST API. `to` and `from` must be in
/// Twilio's raw form (including the "whatsapp:" prefix for WhatsApp) — the
/// caller is responsible for routing to the right channel.
export async function sendTwilioMessage(
  to: string,
  from: string,
  body: string,
  callbackParams?: Record<string, string>
): Promise<void> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN");
  if (!authToken) {
    // THROW, don't return. A silent return reads as success to every caller —
    // the reminder worker marked rows sentAt for messages that were never even
    // attempted. Failing loudly lets it dead-letter them instead.
    throw new Error("TWILIO_AUTH_TOKEN is unset — cannot send outbound message");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const cb = statusCallbackUrl(callbackParams);
  if (cb) params.set("StatusCallback", cb);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Same reasoning: a logged-and-swallowed failure is indistinguishable from
    // a delivered message to anything upstream.
    throw new Error(`Twilio send failed (${res.status}): ${text}`);
  }
}

/// Send a WhatsApp *template* message via the Twilio Content API. WhatsApp
/// blocks business-*initiated* messages (anything outside the 24h reply window)
/// unless they use a pre-approved template, so a proactive push like the
/// morning brief can't use a plain Body — it references an approved template by
/// its Content SID and passes the dynamic parts as variables (keyed "1", "2", …
/// to match the template's {{1}}, {{2}} placeholders). `to`/`from` are raw
/// Twilio WhatsApp addresses ("whatsapp:+…"). Throws on an HTTP failure so a
/// cron caller surfaces the error; a missing auth token is logged and skipped
/// (local dev without Twilio configured).
export async function sendWhatsAppTemplate(
  to: string,
  from: string,
  contentSid: string,
  variables: Record<string, string>,
  callbackParams?: Record<string, string>
): Promise<void> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN");
  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is unset — cannot send WhatsApp template");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({
    From: from,
    To: to,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
  const cb = statusCallbackUrl(callbackParams);
  if (cb) params.set("StatusCallback", cb);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio WhatsApp template send failed (${res.status}): ${text}`);
  }
}

/// Fetch the rendered body of a sent message by SID. Used by the status
/// callback to recover the text of a failed WhatsApp message (Twilio's status
/// webhook carries the SID but not the body) so it can be resent over SMS.
/// Returns null if unauthenticated or the lookup fails.
export async function getTwilioMessageBody(sid: string): Promise<string | null> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = optionalEnv("TWILIO_AUTH_TOKEN");
  if (!authToken || !sid) return null;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { body?: string } | null;
  return data?.body?.trim() || null;
}
