import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { optionalEnv, DEFAULT_DESTINATION_EMAIL } from "@/lib/env";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { buildMorningBriefs } from "@/lib/brief/morning";
import { sendTwilioMessage, sendWhatsAppTemplate } from "@/lib/sms/send";
import { sendEmail } from "@/lib/notify/email";
import { escapeHtml } from "@/lib/notify/render";

export const runtime = "nodejs";
// Never cache; must run fresh each invocation.
export const dynamic = "force-dynamic";

/// Ensure a phone number carries the "whatsapp:" channel prefix Twilio expects.
function whatsappAddress(num: string): string {
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

/// Email the (multi-line) brief to the owner — a reliable channel independent
/// of WhatsApp's 24h window. Best-effort; no-ops without RESEND_API_KEY.
/// Returns whether it was sent.
async function emailBriefToHost(now: DateTime, freeform: string): Promise<boolean> {
  if (!optionalEnv("RESEND_API_KEY")) return false;
  const to = optionalEnv("OWNER_EMAIL") ?? optionalEnv("HUNTER_EMAIL") ?? DEFAULT_DESTINATION_EMAIL;
  const dateLabel = now.setZone(OWNER_TIMEZONE).toFormat("EEEE, MMM d");
  const bodyHtml = freeform
    .split("\n")
    .map((line, i) => (line === "" ? "" : i === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line)))
    .join("<br>");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">` +
    `☀️ <strong>Good morning, ${OWNER_FIRST_NAME}!</strong><br><br>${bodyHtml}</div>`;
  try {
    await sendEmail(to, `☀️ Morning brief — ${dateLabel}`, `☀️ Good morning, ${OWNER_FIRST_NAME}!\n\n${freeform}`, html);
    return true;
  } catch (err) {
    console.error("[brief] email send failed:", err);
    return false;
  }
}

// The daily-send marker: a pre-sent Nudge row keyed by the owner-local day.
// sentAt is set on creation, so it never appears in the reminders UI (which
// filters sentAt: null) and the nudge worker never dispatches it. Using Nudge
// avoids a schema migration for a one-row bookkeeping need.
const BRIEF_MARKER_KIND = "brief";

async function briefAlreadySentOn(dayISO: string): Promise<boolean> {
  const marker = await prisma.nudge.findFirst({
    where: { eventKind: BRIEF_MARKER_KIND, eventId: dayISO },
  });
  return marker != null;
}

async function recordBriefSent(dayISO: string, now: DateTime): Promise<void> {
  await prisma.nudge.create({
    data: {
      body: "Morning brief sent",
      fireAt: now.toUTC().toJSDate(),
      timezone: OWNER_TIMEZONE,
      eventKind: BRIEF_MARKER_KIND,
      eventId: dayISO,
      sentAt: now.toUTC().toJSDate(),
    },
  });
}

// Invoked by Vercel Cron every hour (see vercel.json). We send on the FIRST
// invocation whose local hour (owner's timezone) is 7–10am that hasn't already
// sent today — an hourly trigger + local-hour window is DST-safe, and the
// catch-up window means a missed or late 7am tick (Vercel crons are
// best-effort) self-heals at 8/9/10 instead of silently skipping the whole
// day (which happened on 2026-08-03). The per-day marker guarantees at most
// one send. Pass ?force=1 (still behind the CRON_SECRET check) to send
// immediately regardless of hour/marker, for testing.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv("CRON_SECRET");
  if (secret) {
    const auth = req.headers.get("authorization");
    if (!safeEqual(auth ?? "", `Bearer ${secret}`)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Refuse to run unprotected in production.
    return NextResponse.json({ error: "cron_secret_not_configured" }, { status: 500 });
  }

  const now = DateTime.now().setZone(OWNER_TIMEZONE);
  const force = new URL(req.url).searchParams.get("force") === "1";
  if ((now.hour < 7 || now.hour > 10) && !force) {
    return NextResponse.json({
      skipped: true,
      reason: "outside 7-10am local send window",
      localHour: now.hour,
      timezone: OWNER_TIMEZONE,
    });
  }
  const dayISO = now.toISODate()!;
  if (!force && (await briefAlreadySentOn(dayISO))) {
    return NextResponse.json({ skipped: true, reason: "already sent today", day: dayISO });
  }

  // One fetch renders both shapes: the single line (template) and the
  // multi-line agenda (email + freeform WA). Accounts that still failed after
  // the built-in retry are logged here — a silent warning is how a two-meeting
  // Saturday once went out as "nothing on your calendar" (2026-08-15).
  const { line: briefLine, freeform, warnings } = await buildMorningBriefs(now);
  if (warnings.length > 0) console.error("[brief] calendar warnings:", JSON.stringify(warnings));

  // Email always goes out (best-effort) so the digest never depends on WhatsApp's
  // 24h window being open.
  const emailed = await emailBriefToHost(now, freeform);

  // WhatsApp: an approved template delivers any time; otherwise a freeform
  // message that lands inside the 24h window (kept open by daily agent use).
  // Best-effort: a Twilio error must not 500 the route after the email went
  // out (and must not prevent the sent-marker, or the 8-10am catch-ups would
  // re-email daily on any WhatsApp failure).
  const rawTo =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  const from = optionalEnv("TWILIO_WHATSAPP_FROM");
  const contentSid = optionalEnv("TWILIO_MORNING_BRIEF_CONTENT_SID");
  let whatsapp: "template" | "freeform" | "failed" | "not_configured" = "not_configured";
  if (rawTo && from) {
    try {
      if (contentSid) {
        await sendWhatsAppTemplate(whatsappAddress(rawTo), whatsappAddress(from), contentSid, {
          "1": briefLine,
        });
        whatsapp = "template";
      } else {
        await sendTwilioMessage(
          whatsappAddress(rawTo),
          whatsappAddress(from),
          `☀️ Good morning, ${OWNER_FIRST_NAME}!\n\n${freeform}`
        );
        whatsapp = "freeform";
      }
    } catch (err) {
      console.error("[brief] WhatsApp send failed:", err);
      whatsapp = "failed";
    }
  }

  const sent = emailed || whatsapp === "template" || whatsapp === "freeform";
  // Mark the day as handled if ANY channel delivered (or even if both failed —
  // a marker on total failure would suppress retries, so only record on
  // success; a totally-failed 7am run gets retried at 8/9/10).
  if (sent) await recordBriefSent(dayISO, now);

  return NextResponse.json({ sent, emailed, whatsapp, brief: freeform });
}
