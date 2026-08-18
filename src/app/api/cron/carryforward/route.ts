import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { carryForwardTodos } from "@/lib/todos/carryForward";
import { materializeRecurringTodos } from "@/lib/todos/recurring";

export const runtime = "nodejs";
// Never cache; must run fresh each invocation.
export const dynamic = "force-dynamic";

// The daily to-do maintenance run. Two independent steps:
//   1. materializeRecurringTodos — seed today's due recurring actionables ("pay
//      rent, last day of every month") as ordinary Todo rows.
//   2. carryForwardTodos — duplicate yesterday's unfinished actionables onto
//      today so a to-do you didn't get to is never silently dropped.
// Actionables only — events, bookings and blocks are never touched.
//
// Runs once a day (vercel.json: "0 14 * * *", i.e. 14:00 UTC = 7 AM PDT / 6 AM
// PST — the owner is PACIFIC). It MUST fire past owner-local midnight, because
// carryForwardTodos derives "today" in OWNER_TIMEZONE: the old "0 6 * * *" was
// 11 PM Pacific the night before, so it carried a full day behind (see
// docs/REGRESSIONS.md, Blocks pane). It carries "the day that just ended" into
// the new day, so a slightly-late firing can't miss a day the way an exact
// 11:59 PM "today -> tomorrow" sweep would. If OWNER_TIMEZONE changes, re-check
// this UTC hour still lands just after local midnight.
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
    // Seed today's due recurring actionables FIRST (independent of carry-forward:
    // this writes today; carry-forward reads yesterday). An unfinished one then
    // carries forward like any other actionable.
    const recurring = await materializeRecurringTodos();
    const result = await carryForwardTodos();
    return NextResponse.json({ ok: true, recurring, ...result });
  } catch (err) {
    console.error("[carryforward] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
