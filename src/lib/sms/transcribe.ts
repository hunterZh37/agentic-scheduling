import { requireEnv } from "@/lib/env";

// Speech-to-text for inbound WhatsApp voice notes. Twilio delivers a voice note
// as media (an audio/ogg Opus file) referenced by a MediaUrl on the inbound
// webhook. Claude can't accept audio, so we transcribe with OpenAI's Whisper
// endpoint and feed the resulting text into the same agent that handles typed
// messages.

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODEL = "whisper-1";

interface MediaRef {
  url: string;
  contentType: string;
}

/// Find the first audio attachment in a Twilio inbound webhook payload. Twilio
/// sends NumMedia plus MediaUrl{i}/MediaContentType{i} for each part; a WhatsApp
/// voice note arrives as a single audio/ogg part with an empty Body. Pure —
/// unit-testable without the network.
export function firstAudioMedia(params: Record<string, string>): MediaRef | null {
  const count = parseInt(params.NumMedia ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  for (let i = 0; i < count; i++) {
    const contentType = params[`MediaContentType${i}`] ?? "";
    const url = params[`MediaUrl${i}`] ?? "";
    if (url && /^audio\//i.test(contentType)) return { url, contentType };
  }
  return null;
}

/// Download the audio bytes behind a Twilio MediaUrl. The URL requires Basic
/// auth (account SID + auth token), but it 302-redirects to a CDN (S3) that
/// REJECTS a forwarded Authorization header — so we fetch with manual redirect
/// handling and re-request the Location without the auth header.
async function downloadTwilioMedia(mediaUrl: string): Promise<Blob> {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const first = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: "manual",
  });

  // Followed the redirect to the CDN: re-request WITHOUT the auth header.
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error(`Twilio media redirect had no Location (${first.status})`);
    const cdn = await fetch(location);
    if (!cdn.ok) throw new Error(`Twilio media CDN fetch failed (${cdn.status})`);
    return cdn.blob();
  }

  if (!first.ok) throw new Error(`Twilio media fetch failed (${first.status})`);
  return first.blob();
}

/// Transcribe a Twilio voice-note MediaUrl to text via OpenAI Whisper. Returns
/// the trimmed transcript, or "" if transcription fails or produces nothing —
/// the caller decides how to surface an empty result to the user.
export async function transcribeAudio(mediaUrl: string, contentType: string): Promise<string> {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  try {
    const audio = await downloadTwilioMedia(mediaUrl);
    // Give the file a plausible extension from the content type (e.g. audio/ogg
    // -> voice.ogg) so Whisper's decoder picks the right container.
    const ext = (contentType.split("/")[1] || "ogg").split(";")[0];
    const form = new FormData();
    form.append("file", audio, `voice.${ext}`);
    form.append("model", OPENAI_MODEL);
    form.append("response_format", "text");
    form.append("language", "en");

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[sms] OpenAI transcription failed (${res.status}): ${detail}`);
      return "";
    }
    // response_format=text returns the transcript as a plain string body.
    const text = (await res.text()).trim();
    return text;
  } catch (err) {
    console.error("[sms] transcription error:", err);
    return "";
  }
}
