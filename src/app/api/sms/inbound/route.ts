import { NextRequest, NextResponse, after } from "next/server";
import { optionalEnv, requireEnv, APP_BASE_URL } from "@/lib/env";
import { runPrivateAgent, type ChatMessage } from "@/lib/agent/run";
import { checkSmsAllowed } from "@/lib/agent/rateLimit";
import { verifyTwilioSignature, isAuthorizedSender, normalizePhone } from "@/lib/sms/verify";
import { loadConversation, saveConversation, resetConversation } from "@/lib/sms/conversation";
import { sendTwilioMessage } from "@/lib/sms/send";
import { firstAudioMedia, transcribeAudio } from "@/lib/sms/transcribe";

export const runtime = "nodejs";
export const maxDuration = 60;

// Two-way SMS control channel for the PRIVATE agent. Twilio POSTs an inbound
// message here as x-www-form-urlencoded; we reply with TwiML that Twilio texts
// back to the sender. Access is double-gated: a valid Twilio signature (really
// from Twilio) AND From === OWNER_SMS_NUMBER (really from the owner). Nothing
// else ever reaches the agent.

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/// Build a TwiML response. Pass a message to reply, or nothing for a silent
/// acknowledgement (empty <Response/> = Twilio sends no text back).
function twiml(message?: string): NextResponse {
  const inner = message ? `<Message>${xmlEscape(message)}</Message>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Twilio sends x-www-form-urlencoded; formData() covers it. Flatten to a
  // string map for both the signature check and field access.
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === "string" ? value : "";
  }
  // Twilio prefixes WhatsApp senders as "whatsapp:+1...". Strip it so the
  // sender allowlist and conversation key work identically for SMS and
  // WhatsApp (the TwiML reply routes back over whichever channel came in).
  const from = (params.From ?? "").replace(/^whatsapp:/i, "");
  const body = (params.Body ?? "").trim();

  // 1. Signature validation. The signed URL is the PUBLIC one Twilio was
  // configured with — build it from APP_BASE_URL, since req.url is internal
  // behind a tunnel/proxy. SMS_SKIP_SIGNATURE_CHECK is a local-dev escape hatch.
  if (optionalEnv("SMS_SKIP_SIGNATURE_CHECK") === "true") {
    console.warn(
      "[sms] SMS_SKIP_SIGNATURE_CHECK=true — skipping Twilio signature validation (dev/local only)"
    );
  } else {
    const signature = req.headers.get("x-twilio-signature");
    const url = `${APP_BASE_URL}${new URL(req.url).pathname}`;
    const valid =
      signature != null &&
      verifyTwilioSignature({
        url,
        params,
        signature,
        authToken: requireEnv("TWILIO_AUTH_TOKEN"),
      });
    if (!valid) {
      console.warn("[sms] rejected inbound with invalid Twilio signature");
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // 2. Authorization. Only the owner's number may control the agent.
  const ownerNumber = optionalEnv("OWNER_SMS_NUMBER") ?? optionalEnv("HUNTER_SMS_NUMBER");
  if (!ownerNumber) {
    console.error("[sms] OWNER_SMS_NUMBER is unset — SMS control is not configured");
    return twiml("SMS control isn't set up yet. Set OWNER_SMS_NUMBER on the server to enable it.");
  }
  if (!isAuthorizedSender(from, ownerNumber)) {
    return twiml("Sorry — this number isn't authorized to use this assistant.");
  }

  const phone = normalizePhone(from);

  // 3. Rate limit (per phone number).
  if (!checkSmsAllowed(phone).ok) {
    return twiml("You're texting a bit fast — give me a moment and try again.");
  }

  // Reset command clears the rolling history.
  if (/^(reset|new)$/i.test(body)) {
    await resetConversation(phone);
    return twiml("Conversation reset. What can I help you with?");
  }

  // Reply routing uses the RAW From/To (with the "whatsapp:" prefix intact
  // where present) so WhatsApp replies land on the right channel — only the
  // allowlist/conversation key uses the stripped `from`.
  const replyTo = params.From ?? "";
  const replyFrom = params.To ?? "";

  // 4a. Voice note. A WhatsApp voice note arrives as an audio attachment with an
  // empty Body. Transcribe it (OpenAI Whisper) and drive the agent with the text.
  // Transcription + agent take several seconds, so we ack instantly with a TwiML
  // reply and do the real work out-of-band via `after` (same reasoning as the
  // text path below). Gating (signature/authorization/rate-limit) already ran,
  // so only the owner's voice ever reaches transcription.
  const audio = firstAudioMedia(params);
  if (!body && audio) {
    after(async () => {
      try {
        const transcript = await transcribeAudio(audio.url, audio.contentType);
        if (!transcript) {
          await sendTwilioMessage(
            replyTo,
            replyFrom,
            "Sorry, I couldn't make out that voice note — try again or type it."
          );
          return;
        }
        const history = await loadConversation(phone);
        const userTurn: ChatMessage = { role: "user", content: transcript };
        const reply = await runPrivateAgent([...history, userTurn], {
          concise: true,
          voiceTranscript: transcript,
        });
        await saveConversation(phone, [...history, userTurn, { role: "assistant", content: reply }]);
        await sendTwilioMessage(replyTo, replyFrom, reply);
      } catch (err) {
        console.error("[sms] voice-note run failed:", err);
        await sendTwilioMessage(replyTo, replyFrom, "Sorry, something went wrong. Please try again.");
      }
    });
    return twiml("🎙️ Got it, one sec…");
  }

  // Non-audio media with no text (e.g. an image): nothing we can act on.
  if (!body && parseInt(params.NumMedia ?? "0", 10) > 0) {
    return twiml("I can only read text and voice notes right now.");
  }

  // Empty body (e.g. an MMS with no text): nothing to run, ack silently.
  if (!body) return twiml();

  // 4. Conversation continuity + agent run. The agent can take 8-18s, well
  // past Twilio's ~15s webhook timeout, so we ack immediately with an empty
  // TwiML response and send the actual reply out-of-band via the Twilio REST
  // API once the agent finishes.
  // We ack immediately with an empty TwiML response, then run the agent and
  // deliver the reply out-of-band. `after` schedules this to run once the
  // response is flushed; on Vercel it is backed by `waitUntil`, which keeps
  // the serverless invocation alive (up to this route's maxDuration) until the
  // work settles. A bare fire-and-forget promise would be frozen the instant
  // the function returns, so the reply would never be sent in production.
  after(async () => {
    try {
      const history = await loadConversation(phone);
      const messages: ChatMessage[] = [...history, { role: "user", content: body }];
      const reply = await runPrivateAgent(messages, { concise: true });
      await saveConversation(phone, [...messages, { role: "assistant", content: reply }]);
      await sendTwilioMessage(replyTo, replyFrom, reply);
    } catch (err) {
      console.error("[sms] agent run failed:", err);
      await sendTwilioMessage(replyTo, replyFrom, "Sorry, something went wrong. Please try again.");
    }
  });

  return twiml();
}
