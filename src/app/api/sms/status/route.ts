import { NextRequest, NextResponse } from "next/server";
import { optionalEnv, requireEnv, APP_BASE_URL } from "@/lib/env";
import { verifyTwilioSignature } from "@/lib/sms/verify";
import { sendTwilioMessage, getTwilioMessageBody } from "@/lib/sms/send";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/notify/email";
import { renderReminder } from "@/lib/notify/render";
import { resolveContact } from "@/lib/notify/contact";

export const runtime = "nodejs";

// Twilio message status callback. WhatsApp delivery can fail asynchronously —
// e.g. error 63112 when the WhatsApp Business account is unverified — *after*
// the send API already returned 201, so the failure can't be caught at send
// time. Twilio POSTs each status transition here; when a WhatsApp message ends
// in failed/undelivered we resend the same text as a plain SMS from
// TWILIO_FROM_NUMBER so the owner still gets the reply. Only WhatsApp (whatsapp:)
// sends are retried — an SMS has no such prefix, so the fallback can never
// retry itself and loop.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === "string" ? value : "";
  }

  // Signature validation, same scheme as the inbound webhook: sign against the
  // PUBLIC url (APP_BASE_URL), since req.url is internal behind a proxy.
  if (optionalEnv("SMS_SKIP_SIGNATURE_CHECK") === "true") {
    console.warn("[sms] SMS_SKIP_SIGNATURE_CHECK=true — skipping signature validation (dev only)");
  } else {
    const signature = req.headers.get("x-twilio-signature");
    // Twilio signs the FULL callback URL it was given, query string included.
    // Verifying against the path alone worked only while no parameters were
    // used; adding ?reminderId=… would silently start rejecting every callback.
    const incoming = new URL(req.url);
    const url = `${APP_BASE_URL}${incoming.pathname}${incoming.search}`;
    const valid =
      signature != null &&
      verifyTwilioSignature({
        url,
        params,
        signature,
        authToken: requireEnv("TWILIO_AUTH_TOKEN"),
      });
    if (!valid) {
      console.warn("[sms] rejected status callback with invalid Twilio signature");
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  const status = (params.MessageStatus ?? "").toLowerCase();
  const from = params.From ?? "";
  const terminalFailure = status === "failed" || status === "undelivered";

  // Record the outcome on the reminder that asked for this message. Until now
  // `sentAt` meant "Twilio accepted it", so a reminder that failed minutes
  // later still read as delivered — the owner had no way to know one had been
  // missed. Done for ANY channel, before the WhatsApp-only SMS fallback below.
  const reminderId = new URL(req.url).searchParams.get("reminderId");
  if (terminalFailure && reminderId) {
    try {
      await prisma.reminder.updateMany({
        // Only a row this run actually claimed — never resurrect one that has
        // since been re-sent or already dead-lettered.
        where: { id: reminderId, failedAt: null },
        data: { sentAt: null, failedAt: new Date() },
      });
      console.warn(
        `[sms] reminder ${reminderId} marked failed (${status}, error ${params.ErrorCode || "?"})`
      );
    } catch (err) {
      // Never fail the webhook over bookkeeping: Twilio would retry the
      // callback and the SMS fallback below would send twice.
      console.error("[sms] could not mark reminder failed:", err);
    }
  }
  // Only act on a terminal failure of a WhatsApp send. Everything else
  // (delivered/read/sent/queued, or any SMS status) is acknowledged and
  // ignored — the whatsapp: guard is also what stops the fallback looping.
  if (!terminalFailure || !/^whatsapp:/i.test(from)) {
    return new NextResponse(null, { status: 204 });
  }

  // Email fallback. The SMS fallback below cannot work here: TWILIO_FROM_NUMBER
  // is A2P-unregistered, so those sends fail with 30034 — a fallback to
  // nothing. Email is the channel that actually delivers, so a reminder that
  // Meta refused still reaches the owner.
  //
  // This is what makes error 63049 survivable. 63049 is Meta declining to
  // deliver a MARKETING-categorised template to a US number, which no retry and
  // no code change can fix; the template has to be recategorised as Utility.
  // Until that happens, the reminder arrives by email instead of not at all.
  if (reminderId) {
    try {
      const reminder = await prisma.reminder.findUnique({
        where: { id: reminderId },
        include: { booking: true },
      });
      if (reminder?.booking && reminder.booking.status !== "cancelled") {
        const contact = await resolveContact(reminder.recipient, reminder.booking);
        if (contact.email) {
          const msg = renderReminder({
            title: reminder.booking.title,
            start: reminder.booking.startTime,
            attendeeName: reminder.booking.attendeeName,
            recipient: reminder.recipient,
            timezone: contact.timezone,
          });
          await sendEmail(
            contact.email,
            msg.subject,
            `${msg.text}\n\n(WhatsApp could not deliver this reminder — error ${params.ErrorCode || "?"}.)`
          );
          console.warn(`[sms] reminder ${reminderId} delivered by email instead of WhatsApp`);
        }
      }
    } catch (err) {
      console.error("[sms] email fallback failed:", err);
    }
  }

  const smsFrom = optionalEnv("TWILIO_FROM_NUMBER");
  const to = (params.To ?? "").replace(/^whatsapp:/i, "");
  if (!smsFrom || !to) {
    console.error("[sms] cannot fall back to SMS — TWILIO_FROM_NUMBER or recipient missing");
    return new NextResponse(null, { status: 204 });
  }

  const body = await getTwilioMessageBody(params.MessageSid ?? "");
  if (!body) return new NextResponse(null, { status: 204 });

  console.warn(
    `[sms] WhatsApp ${status} (error ${params.ErrorCode || "?"}) — falling back to SMS`
  );
  await sendTwilioMessage(to, smsFrom, body);
  return new NextResponse(null, { status: 200 });
}
