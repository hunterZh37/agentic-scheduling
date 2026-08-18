import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { checkMessaging } from "@/lib/notify/health";

export const runtime = "nodejs";
// Health must reflect this instant, never a cached earlier answer.
export const dynamic = "force-dynamic";

// Liveness for the three subsystems everything else rests on. Public and
// unauthenticated by design (it is polled before every push and by external
// monitors), so it reports only ok/fail per subsystem — never a driver error
// string, connection URL, or key, which would hand an attacker a map of the
// infrastructure.
//
// Distinct from /api/cron/monitor: that one is the deep synthetic check and it
// ALERTS over WhatsApp and email, so it must not be polled routinely.

type Status = "ok" | "fail";

/// The database backs bookings, blocks, reminders and both agents. A trivial
/// count proves the pool can actually reach Postgres, not merely that Prisma
/// loaded.
async function checkDatabase(): Promise<Status> {
  try {
    await prisma.account.count();
    return "ok";
  } catch {
    return "fail";
  }
}

/// The agent needs its model credentials. This checks CONFIGURATION only — it
/// deliberately does not call the model, because health is polled on every push
/// and every call costs money. A missing key is the failure that actually
/// happens; the SDK reads ANTHROPIC_API_KEY from the environment itself.
function checkAgent(): Status {
  return optionalEnv("ANTHROPIC_API_KEY") ? "ok" : "fail";
}

export async function GET(): Promise<NextResponse> {
  const [database, agent] = [await checkDatabase(), checkAgent()];
  // Messaging is checked here too: a reminder that cannot be delivered is a
  // silent failure, and the only cheap way to notice is to look before one is
  // due. Sends nothing — configuration and read-only credential probes only.
  const messaging = await checkMessaging();
  // Reaching this handler at all is what "api: ok" attests: routing, the Node
  // runtime, and the proxy all worked.
  const checks = {
    database,
    api: "ok" as Status,
    agent,
    messaging: (messaging.ok ? "ok" : "fail") as Status,
  };
  const ok = Object.values(checks).every((c) => c === "ok");
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      checks,
      warnings: messaging.hasWarnings || undefined,
      // Named problems only — never a credential, and nothing when healthy.
      // Names only, never a credential. Warnings are reported but do not make
      // the endpoint unhealthy — they describe delivery that already failed,
      // not an inability to send now.
      messagingProblems: messaging.checks
        .filter((c) => c.state === "fail" || c.state === "warn")
        .map((c) => `${c.name}:${c.state}`),
    },
    { status: ok ? 200 : 503 }
  );
}
