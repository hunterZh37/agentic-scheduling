import { requireEnv } from "@/lib/env";
import { sendWhatsAppTemplate } from "@/lib/sms/send";

/// A WhatsApp address is Twilio's raw phone number prefixed with "whatsapp:".
function whatsappAddress(num: string): string {
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

/// Send a reminder over WhatsApp using an approved content template, so it
/// delivers reliably even outside the 24h WhatsApp session window (unlike a
/// freeform message). Requires both TWILIO_WHATSAPP_FROM and
/// TWILIO_REMINDER_CONTENT_SID — throws a clear error when either is missing
/// so the worker's retry/dead-letter logic treats it as a transient failure.
export async function sendWhatsAppReminder(
  to: string,
  detail: string,
  reminderId?: string
): Promise<void> {
  const from = requireEnv("TWILIO_WHATSAPP_FROM");
  const contentSid = requireEnv("TWILIO_REMINDER_CONTENT_SID");
  await sendWhatsAppTemplate(
    whatsappAddress(to),
    whatsappAddress(from),
    contentSid,
    { "1": detail },
    // Twilio echoes the callback URL, so the delivery outcome can be tied back
    // to the row that asked for it. Without this the webhook knows a message
    // failed but not which reminder to mark.
    reminderId ? { reminderId } : undefined
  );
}
