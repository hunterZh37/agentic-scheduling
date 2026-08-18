import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { processDueReminders } from "@/lib/notify/worker";
import { processDueNudges } from "@/lib/nudge/worker";

export const runtime = "nodejs";
// Never cache; must run fresh each invocation.
export const dynamic = "force-dynamic";

// Invoked by Vercel Cron every 5 minutes (see vercel.json). Vercel attaches
// `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set — we reject
// anything else so the endpoint can't be triggered by the public.
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

  // Run both workers independently: a failure in one must not 500 the route or
  // discard the other's result (they share this every-5-min cron).
  const [remindersR, nudgesR] = await Promise.allSettled([processDueReminders(), processDueNudges()]);
  return NextResponse.json({
    reminders: remindersR.status === "fulfilled" ? remindersR.value : { error: String(remindersR.reason) },
    nudges: nudgesR.status === "fulfilled" ? nudgesR.value : { error: String(nudgesR.reason) },
  });
}
