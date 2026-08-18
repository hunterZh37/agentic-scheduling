import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { ownerEmailAddress } from "@/lib/notify/contact";
import { sendTwilioMessage, sendWhatsAppTemplate, whatsappAddress } from "@/lib/sms/send";
import { fetchReputation, snapshotKey, describeChange, describeDaily, dailySubject, whatsappSummary } from "@/lib/reputation/check";
import { sendEmail } from "@/lib/notify/email";
import { escapeHtml } from "@/lib/notify/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily domain-reputation watch. bookwithhunter.com was auto-classified as
// Phishing/Malware by several web filters because it is a young domain, which
// got it blocked on filtered networks (e.g. gym guest WiFi). Recategorization
// requests are in with each vendor, but their own lookup pages are CAPTCHA- or
// Cloudflare-gated and can't be polled. VirusTotal aggregates ~90 engines —
// including Fortinet and Trellix — in a single authenticated call, so this cron
// watches that instead and emails ONLY when a verdict changes.
//
// Requires VIRUSTOTAL_API_KEY (free tier is ample at one call/day). Without it
// the route no-ops rather than failing, so the cron is harmless until set up.

// Reuses the Nudge table as a tiny key/value log (same trick as the morning
// brief's sent-marker): pre-sent rows are invisible to the reminders UI and the
// nudge worker, so no schema migration is needed for this bookkeeping.
const MARKER_KIND = "reputation";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv("CRON_SECRET");
  if (secret) {
    const auth = req.headers.get("authorization");
    if (!safeEqual(auth ?? "", `Bearer ${secret}`)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "cron_secret_not_configured" }, { status: 500 });
  }

  const snapshot = await fetchReputation();
  if (!snapshot) {
    return NextResponse.json({ skipped: true, reason: "virustotal_not_configured_or_unavailable" });
  }

  const previous = await prisma.nudge.findFirst({
    where: { eventKind: MARKER_KIND },
    orderBy: { createdAt: "desc" },
  });
  const prevKey = previous?.eventId ?? null;
  const change = describeChange(prevKey, snapshot);
  const nextKey = snapshotKey(snapshot);

  // Record every run so the next one has a baseline (and so a first run after
  // deploy establishes state without alerting on it).
  const now = new Date();
  await prisma.nudge.create({
    data: {
      body: `Reputation: ${snapshot.flagged.length}/${snapshot.total} flagging`,
      fireAt: now,
      timezone: "UTC",
      eventKind: MARKER_KIND,
      eventId: nextKey,
      sentAt: now,
    },
  });

  const isFirstRun = previous == null;
  // Send EVERY day, not only when something moves. Change-only was silent on a
  // quiet day, which is correct for an alert but useless as an audit: no email
  // and a broken cron look identical from the owner's inbox. The subject line
  // carries whether anything changed, so quiet days stay one glance to dismiss.
  const body = describeDaily(prevKey, snapshot);
  let emailed = false;
  const to = await ownerEmailAddress();
  if (!to) {
    console.error(
      "[reputation] no owner email resolved — set OWNER_EMAIL or connect a destination calendar"
    );
  }
  if (to && optionalEnv("RESEND_API_KEY")) {
    const subject = dailySubject(prevKey, snapshot);
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">` +
      body.split("\n").map((l) => escapeHtml(l)).join("<br>") +
      `<br><br><a href="https://www.virustotal.com/gui/domain/bookwithhunter.com">View on VirusTotal</a></div>`;
    try {
      await sendEmail(to, subject, body, html);
      emailed = true;
    } catch (err) {
      console.error("[reputation] email failed:", err);
    }
  }

  // WhatsApp, alongside the email. Best-effort: a Twilio failure must not 500
  // the cron after the email has already gone out, and must not stop the
  // snapshot marker being written (that would re-alert on the next run).
  //
  // WhatsApp blocks business-INITIATED messages outside the 24h reply window
  // unless they use a pre-approved template, and this fires at 09:00 with no
  // conversation open — so without a Content SID the freeform path will usually
  // be rejected (error 63016). The status is reported rather than swallowed.
  const rawTo =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  const waFrom = optionalEnv("TWILIO_WHATSAPP_FROM");
  const contentSid = optionalEnv("TWILIO_REPUTATION_CONTENT_SID");
  const summary = whatsappSummary(prevKey, snapshot);
  let whatsapp: "template" | "freeform" | "failed" | "not_configured" = "not_configured";
  if (rawTo && waFrom) {
    try {
      if (contentSid) {
        await sendWhatsAppTemplate(whatsappAddress(rawTo), whatsappAddress(waFrom), contentSid, {
          "1": summary,
        });
        whatsapp = "template";
      } else {
        await sendTwilioMessage(whatsappAddress(rawTo), whatsappAddress(waFrom), `🔎 ${summary}`);
        whatsapp = "freeform";
      }
    } catch (err) {
      console.error("[reputation] WhatsApp send failed:", err);
      whatsapp = "failed";
    }
  } else {
    console.error(
      "[reputation] WhatsApp not configured — need OWNER_WHATSAPP_NUMBER and TWILIO_WHATSAPP_FROM"
    );
  }

  return NextResponse.json({
    whatsapp,
    flagged: snapshot.flagged,
    total: snapshot.total,
    changed: change != null && !isFirstRun,
    baselineEstablished: isFirstRun,
    emailed,
    // Surfaced so a silent audit is diagnosable from the cron response alone.
    recipient: to ?? "(none resolved)",
  });
}
