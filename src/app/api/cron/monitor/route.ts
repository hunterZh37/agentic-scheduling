import { NextRequest, NextResponse } from "next/server";
import { optionalEnv, PUBLIC_BASE_URL } from "@/lib/env";
import { prisma } from "@/lib/db";
import { checkMessaging } from "@/lib/notify/health";
import { runChecksWithRetry } from "@/lib/monitor/retry";
import { sendTwilioMessage } from "@/lib/sms/send";
import { sendEmail } from "@/lib/notify/email";

export const runtime = "nodejs";
// Never cache; must run fresh each invocation.
export const dynamic = "force-dynamic";

// Synthetic monitoring cron (every 4h, see vercel.json). Read-only: it exercises
// the live public surface the way a visitor would — never creates a booking or
// sends any app message — and reports on EVERY feature it checked (pass or fail),
// alerting the owner over WhatsApp + email whenever something is down or visibly
// wrong (e.g. the booking page rendering the placeholder name). This is the
// FUNCTIONAL half; the VISUAL half (headless-browser screenshots + vision
// assessment) is a planned follow-up.

interface CheckResult {
  name: string; // short key (stable, used in the JSON response)
  label: string; // human-readable feature name (shown in alerts)
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 15_000;

/// Fetch with a hard timeout so a hung endpoint can't stall the whole run.
async function timedFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

/// GET a URL and assert HTTP 200. Optionally assert the body includes / excludes
/// specific strings (used to catch the identity regression on /book).
async function checkPage(
  name: string,
  label: string,
  url: string,
  opts: { includes?: string[]; excludes?: string[] } = {}
): Promise<CheckResult> {
  try {
    const res = await timedFetch(url);
    if (res.status !== 200) {
      return { name, label, ok: false, detail: `HTTP ${res.status}` };
    }
    if (opts.includes || opts.excludes) {
      const body = await res.text();
      for (const s of opts.includes ?? []) {
        if (!body.includes(s)) return { name, label, ok: false, detail: `200 but missing "${s}"` };
      }
      for (const s of opts.excludes ?? []) {
        if (body.includes(s)) return { name, label, ok: false, detail: `200 but shows "${s}"` };
      }
    }
    return { name, label, ok: true, detail: "200 OK" };
  } catch (err) {
    return { name, label, ok: false, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/// Availability API: 200 and a well-formed `slots` array. Not asserting non-empty
/// (a legitimately fully-booked week would be empty) — only that the endpoint
/// answers with the right shape.
async function checkAvailability(base: string): Promise<CheckResult> {
  const label = "Availability API (free/busy)";
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${base}/api/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&duration=30`;
  try {
    const res = await timedFetch(url);
    if (res.status !== 200) return { name: "availability", label, ok: false, detail: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as { slots?: unknown } | null;
    if (!data || !Array.isArray(data.slots)) {
      return { name: "availability", label, ok: false, detail: "200 but no slots array" };
    }
    return { name: "availability", label, ok: true, detail: `200 OK, ${data.slots.length} slots` };
  } catch (err) {
    return { name: "availability", label, ok: false, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/// A trivial query confirms the DB layer is reachable (also underpins bookings,
/// reminders, and the agents — if this is down, much is down).
async function checkDatabase(): Promise<CheckResult> {
  const label = "Database";
  try {
    await prisma.account.count();
    return { name: "database", label, ok: true, detail: "reachable" };
  } catch (err) {
    return { name: "database", label, ok: false, detail: `query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function whatsappAddress(num: string): string {
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

/// Next scheduled run of this cron ("0 *\/4 * * *" = every 4h on the hour, UTC).
/// The next boundary hour strictly after `now` whose UTC hour is a multiple of 4.
function nextRunAt(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(0);
  next.setUTCHours(next.getUTCHours() + 1);
  while (next.getUTCHours() % 4 !== 0) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/// Human "Next check: …" line in the owner's timezone, appended to every alert.
function nextRunLine(now: Date): string {
  const tz = optionalEnv("OWNER_TIMEZONE") ?? optionalEnv("HUNTER_TIMEZONE") ?? "America/New_York";
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(nextRunAt(now));
  return `Next check: ${local} (runs every 4h)`;
}

/// Build the alert body. It ALWAYS lists every feature that was checked (pass or
/// fail) so the owner sees the full picture, not just what broke, then the next
/// scheduled run. `preview` only changes the header framing.
function buildBody(checks: CheckResult[], opts: { preview: boolean; now: Date }): string {
  const failures = checks.filter((c) => !c.ok);
  const list = checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label} — ${c.detail}`).join("\n");
  let header: string;
  if (opts.preview) {
    const verdict = failures.length === 0 ? "all checks passing" : `${failures.length} of ${checks.length} failing`;
    header =
      `🧪 bookwithhunter monitor — PREVIEW (${verdict})\n` +
      `This is what a real alert looks like. Normally you're only messaged on failure.`;
  } else {
    header = `⚠️ bookwithhunter monitor: ${failures.length} of ${checks.length} checks failing`;
  }
  return `${header}\n\nChecked ${checks.length} features:\n${list}\n\n${nextRunLine(opts.now)}`;
}

/// Alert the owner over WhatsApp (best-effort freeform — lands only inside
/// WhatsApp's 24h window) AND email (reliable, via Resend), so a failure can't
/// go unnoticed just because the WhatsApp window is closed. Both are best-effort;
/// a send failure is logged, not thrown, so it can't mask the monitor result.
async function alertOwner(checks: CheckResult[], opts: { preview: boolean; now: Date }): Promise<void> {
  const failures = checks.filter((c) => !c.ok);
  const body = buildBody(checks, opts);

  const waTo =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  const waFrom = optionalEnv("TWILIO_WHATSAPP_FROM");
  if (waTo && waFrom) {
    try {
      await sendTwilioMessage(whatsappAddress(waTo), whatsappAddress(waFrom), body);
    } catch (err) {
      console.error("[monitor] WhatsApp alert failed:", err);
    }
  }

  const email =
    optionalEnv("OWNER_EMAIL") ??
    optionalEnv("HUNTER_EMAIL") ??
    optionalEnv("DEFAULT_DESTINATION_EMAIL");
  if (email) {
    const subject = opts.preview
      ? "🧪 bookwithhunter monitor — preview"
      : `⚠️ bookwithhunter monitor: ${failures.length} failing`;
    try {
      await sendEmail(email, subject, body);
    } catch (err) {
      console.error("[monitor] email alert failed:", err);
    }
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth. The scheduled run is authorized like the other crons: Vercel Cron
  // sends `Authorization: Bearer <CRON_SECRET>`. As a convenience for previewing
  // the alert on demand, an optional MONITOR_PREVIEW_TOKEN can also authorize a
  // request via `?token=…` — it's low-privilege (the endpoint is read-only and
  // can only alert the owner), so it's fine to hand-trigger with.
  const url = new URL(req.url);
  const secret = optionalEnv("CRON_SECRET");
  const previewToken = optionalEnv("MONITOR_PREVIEW_TOKEN");
  const bySecret = secret != null && req.headers.get("authorization") === `Bearer ${secret}`;
  const byToken = !!previewToken && url.searchParams.get("token") === previewToken;
  if (!bySecret && !byToken) {
    if (!secret && process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "cron_secret_not_configured" }, { status: 500 });
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Preview mode: send the alert even when everything passes, so the owner can
  // see the message format on demand (the monitor otherwise only messages on
  // failure).
  const preview = url.searchParams.get("preview") === "1";
  const now = new Date();
  const base = PUBLIC_BASE_URL;

  // Wake the database BEFORE anything queries it. Neon's free tier suspends
  // compute after idle; the first query then stalls for seconds, and with a
  // 1-connection Prisma pool everything queued behind it times out at the
  // pool's 10s limit — which once turned one cold start into three "failing"
  // checks in a single run. Failure is ignored: if the DB is truly down, the
  // Database check below reports it properly (twice, via the retry pass).
  const retryDelayMs = process.env.NODE_ENV === "test" ? 0 : 3000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  // Messaging pipelines. Deliberately part of the SAME run that already alerts
  // (a separate cron would be one more thing that can quietly stop), and run
  // BEFORE the concurrent checks so its DB reads don't race them for the pool.
  const messaging = await checkMessaging();
  const messagingChecks: CheckResult[] = messaging.checks.map((c) => ({
    name: `messaging.${c.name}`,
    label: `Messaging — ${c.name}`,
    // A warning still alerts: an undelivered reminder is exactly what the
    // owner needs told. It just does not gate a deploy.
    ok: c.state === "ok" || c.state === "not_configured",
    detail: c.detail,
  }));

  // Feature checks, with one retry for anything that fails (a blip that heals
  // in seconds is not an outage; a real outage fails both attempts).
  const runners = {
    // The identity regression that hit prod: /book must render the real owner
    // name, never the "Alex Rivera" template placeholder.
    book: () =>
      checkPage("book", "Public booking page", `${base}/book`, { includes: ["Hunter"], excludes: ["Book time with Alex"] }),
    privacy: () => checkPage("privacy", "Privacy Policy page", `${base}/privacy`),
    terms: () => checkPage("terms", "Terms of Service page", `${base}/terms`),
    assistant: () => checkPage("assistant", "Assistant page", `${base}/assistant`),
    availability: () => checkAvailability(base),
    database: () => checkDatabase(),
  };
  const checks = await runChecksWithRetry(runners, { delayMs: retryDelayMs });
  checks.push(...messagingChecks);

  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0 || preview) {
    if (failures.length > 0) console.error(`[monitor] ${failures.length} check(s) failing:`, failures);
    await alertOwner(checks, { preview, now });
  }

  return NextResponse.json({
    ok: failures.length === 0,
    preview,
    checkedAt: now.toISOString(),
    base,
    checks,
  });
}
