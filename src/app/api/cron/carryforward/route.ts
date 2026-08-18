import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { carryForwardTodos } from "@/lib/todos/carryForward";

export const runtime = "nodejs";
// Never cache; must run fresh each invocation.
export const dynamic = "force-dynamic";

// Carry-forward: duplicate yesterday's unfinished actionables onto today so a
// to-do you didn't get to is never silently dropped. Actionables only — events,
// bookings and blocks are never touched (see carryForwardTodos).
//
// Runs once a day (vercel.json: "0 6 * * *", i.e. 06:00 UTC = ~1-2 AM US
// Eastern, safely AFTER the owner's midnight in both EST and EDT). It carries
// "the day that just ended" into the new day, so a slightly-late cron firing
// can't miss a day the way an exact 11:59 PM "today -> tomorrow" sweep would.
// The UTC hour assumes an Americas-ish owner timezone; if OWNER_TIMEZONE moves
// far from that, shift the cron so it still lands just after local midnight.
// Idempotent regardless: a re-run (Vercel retry) is a no-op via unique
// rolledFromId.
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

  try {
    const result = await carryForwardTodos();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[carryforward] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
