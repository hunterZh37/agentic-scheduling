import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { sendTwilioMessage } from "@/lib/sms/send";
import { sendEmail } from "@/lib/notify/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Failure sink for the staging end-to-end suite. The GitHub Actions e2e job
// POSTs here when a flow breaks; we forward the summary to the owner over
// WhatsApp (best-effort — 24h window) + email (reliable), reusing prod's Twilio
// and Resend config. Secret-gated by MONITOR_ALERT_SECRET so only the CI job can
// trigger it. Public in proxy.ts (self-authorizes here), like the cron routes.

function whatsappAddress(num: string): string {
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv("MONITOR_ALERT_SECRET");
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 500 });
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : new URL(req.url).searchParams.get("token");
  if (!safeEqual(provided ?? "", secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let summary = "";
  try {
    const body = (await req.json()) as { summary?: string };
    summary = (body.summary ?? "").toString().slice(0, 3000).trim();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!summary) return NextResponse.json({ error: "missing_summary" }, { status: 400 });

  const message = `🧪 e2e monitor (staging) failed\n\n${summary}`;

  const waTo =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  const waFrom = optionalEnv("TWILIO_WHATSAPP_FROM");
  if (waTo && waFrom) {
    try {
      await sendTwilioMessage(whatsappAddress(waTo), whatsappAddress(waFrom), message);
    } catch (err) {
      console.error("[monitor/alert] WhatsApp send failed:", err);
    }
  }

  const email =
    optionalEnv("OWNER_EMAIL") ?? optionalEnv("HUNTER_EMAIL") ?? optionalEnv("DEFAULT_DESTINATION_EMAIL");
  if (email) {
    try {
      await sendEmail(email, "🧪 e2e monitor (staging) failed", message);
    } catch (err) {
      console.error("[monitor/alert] email send failed:", err);
    }
  }

  return NextResponse.json({ ok: true, alerted: { whatsapp: !!(waTo && waFrom), email: !!email } });
}
