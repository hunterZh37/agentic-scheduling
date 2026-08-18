import { optionalEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { ownerEmailAddress } from "./contact";

// Health of the messaging pipelines: email (Resend) and WhatsApp/SMS (Twilio).
//
// Sends NOTHING. Every check is either configuration or a read-only credential
// probe, so it is safe to run on a schedule and costs nothing per run. The
// point is to catch the failures that have actually happened here — a missing
// recipient, a revoked credential, a template SID that was never set — BEFORE
// the next reminder is due, rather than discovering it from a meeting missed.

/// `fail` means we cannot send. `warn` means we could not — something already
/// did not arrive — which is worth an alert but is NOT a reason to block a
/// deploy: it describes the past, and the fix is usually the very push being
/// gated.
export type CheckState = "ok" | "warn" | "fail" | "not_configured";

export interface MessagingCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface MessagingHealth {
  /// Can we send right now? Credentials, recipients, templates.
  ok: boolean;
  /// Anything worth telling the owner about, including past failures.
  hasWarnings: boolean;
  checks: MessagingCheck[];
}

const TIMEOUT_MS = 10_000;

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/// Can we send email at all, and is there somewhere for the owner's mail to go?
/// The recipient half matters as much as the credential: reminders were
/// addressed to a placeholder for weeks while Resend accepted every one.
async function checkEmail(): Promise<MessagingCheck[]> {
  const out: MessagingCheck[] = [];
  const key = optionalEnv("RESEND_API_KEY");
  if (!key) {
    out.push({ name: "email.credentials", state: "not_configured", detail: "RESEND_API_KEY unset" });
  } else {
    try {
      // Cheapest authenticated read Resend offers. 401 = the key is dead.
      const res = await timedFetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
      });
      out.push({
        name: "email.credentials",
        state: res.ok ? "ok" : "fail",
        detail: res.ok ? "Resend key accepted" : `Resend returned ${res.status}`,
      });
    } catch (err) {
      out.push({
        name: "email.credentials",
        state: "fail",
        detail: `Resend unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const to = await ownerEmailAddress();
  out.push({
    name: "email.owner_recipient",
    state: to ? "ok" : "fail",
    detail: to ? `resolves to ${to}` : "no owner address — set OWNER_EMAIL or connect a destination calendar",
  });
  return out;
}

/// Twilio credentials, the WhatsApp sender, and the approved templates a
/// business-initiated message needs. Without a template SID a reminder falls
/// back to freeform, which WhatsApp rejects outside the 24h window (63016).
async function checkTwilio(): Promise<MessagingCheck[]> {
  const out: MessagingCheck[] = [];
  const sid = optionalEnv("TWILIO_ACCOUNT_SID");
  const token = optionalEnv("TWILIO_AUTH_TOKEN");

  if (!sid || !token) {
    out.push({
      name: "twilio.credentials",
      state: "not_configured",
      detail: `${!sid ? "TWILIO_ACCOUNT_SID " : ""}${!token ? "TWILIO_AUTH_TOKEN" : ""} unset`.trim(),
    });
  } else {
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      const res = await timedFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      const active = body?.status === "active";
      out.push({
        name: "twilio.credentials",
        state: res.ok && active ? "ok" : "fail",
        detail: res.ok ? `account status: ${body?.status ?? "unknown"}` : `Twilio returned ${res.status}`,
      });
    } catch (err) {
      out.push({
        name: "twilio.credentials",
        state: "fail",
        detail: `Twilio unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const from = optionalEnv("TWILIO_WHATSAPP_FROM");
  out.push({
    name: "whatsapp.sender",
    state: from ? "ok" : "not_configured",
    detail: from ? "TWILIO_WHATSAPP_FROM set" : "TWILIO_WHATSAPP_FROM unset",
  });

  const reminderSid = optionalEnv("TWILIO_REMINDER_CONTENT_SID");
  out.push({
    name: "whatsapp.reminder_template",
    state: reminderSid ? "ok" : "fail",
    detail: reminderSid
      ? "approved template configured"
      : "TWILIO_REMINDER_CONTENT_SID unset — reminders would send freeform and be rejected outside the 24h window (63016)",
  });

  // The category Meta approved the template under, which decides whether it can
  // be delivered at all. Since 1 Apr 2025 a MARKETING template is not delivered
  // to a US number — Twilio reports 63049 and no retry helps. A booking
  // reminder is a Utility message; if it was approved as Marketing it will
  // silently never arrive, which is exactly what happened here.
  if (sid && token && reminderSid) {
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      const res = await timedFetch(
        `https://content.twilio.com/v1/Content/${reminderSid}/ApprovalRequests`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const body = (await res.json().catch(() => null)) as {
        whatsapp?: { category?: string; status?: string };
      } | null;
      const category = body?.whatsapp?.category?.toLowerCase();
      const status = body?.whatsapp?.status?.toLowerCase();
      if (!res.ok) {
        out.push({
          name: "whatsapp.template_category",
          state: "warn",
          detail: `could not read the template's approval (${res.status})`,
        });
      } else if (category === "marketing") {
        out.push({
          name: "whatsapp.template_category",
          // WARN, not fail. WhatsApp is one channel of two, the email fallback
          // delivers, and the remedy is a category change in the Twilio console
          // — not a deploy. Failing here would 503 /api/health and block every
          // push until someone recategorised a template, which is a third
          // party's approval queue, not this codebase.
          state: "warn",
          detail:
            "reminder template is approved as MARKETING — Meta will not deliver it to US numbers (63049). " +
            "Recategorise it as Utility in the Twilio Content Template Builder.",
        });
      } else {
        out.push({
          name: "whatsapp.template_category",
          state: status === "approved" || status === undefined ? "ok" : "warn",
          detail: `category ${category ?? "unknown"}, status ${status ?? "unknown"}`,
        });
      }
    } catch (err) {
      out.push({
        name: "whatsapp.template_category",
        state: "warn",
        detail: `could not check the template: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const to =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  out.push({
    name: "whatsapp.owner_recipient",
    state: to ? "ok" : "fail",
    detail: to ? "owner number configured" : "no owner WhatsApp/SMS number configured",
  });
  return out;
}

/// The end-to-end signal: reminders the pipeline gave up on. Configuration can
/// look perfect while delivery still fails asynchronously (63049 has happened
/// here), and this is the only check that sees that.
async function checkRecentFailures(now: Date): Promise<MessagingCheck> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  try {
    const failed = await prisma.reminder.count({ where: { failedAt: { gte: since } } });
    return {
      name: "reminders.recent_failures",
      // WARN, not fail: a reminder that already failed is history. Treating it
      // as a hard failure made /api/health 503 and blocked every push for 24
      // hours after a single undelivered message — including the push fixing
      // it.
      state: failed === 0 ? "ok" : "warn",
      detail: failed === 0 ? "none in 24h" : `${failed} reminder(s) failed to deliver in 24h`,
    };
  } catch (err) {
    return {
      name: "reminders.recent_failures",
      state: "fail",
      detail: `could not read reminders: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/// Run every check.
///
/// `fail` is reserved for "this app cannot send at all" — no credentials, no
/// recipient. A degraded single channel is a `warn`: it alerts, but it does not
/// 503 the health endpoint, because that gates every push and the remedy is
/// usually somewhere other than this repository. `not_configured` is not a
/// failure at all; an install without WhatsApp is legitimate.
export async function checkMessaging(now: Date = new Date()): Promise<MessagingHealth> {
  const checks = [
    ...(await checkEmail()),
    ...(await checkTwilio()),
    await checkRecentFailures(now),
  ];
  return {
    ok: checks.every((c) => c.state !== "fail"),
    hasWarnings: checks.some((c) => c.state === "warn"),
    checks,
  };
}

/// One line per problem, for an alert. Empty when everything is fine.
export function messagingProblems(health: MessagingHealth): string[] {
  return health.checks
    .filter((c) => c.state === "fail" || c.state === "warn")
    .map((c) => `${c.name}: ${c.detail}`);
}
