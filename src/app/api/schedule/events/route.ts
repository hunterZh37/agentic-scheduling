import { NextRequest, NextResponse } from "next/server";
import { getAccountEvents } from "@/lib/schedule/service";
import { parseRange } from "@/lib/validation";

export const runtime = "nodejs";

// PRIVATE: one owner calendar's events for the range. The dashboard calls this
// once per calendar after /api/schedule?events=none, so a slow provider only
// delays its own events. A provider failure is a 200 with a warning, the same
// shape /api/schedule reports it in, so the page can say which one didn't sync.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const range = parseRange(url);
  if ("error" in range) {
    return NextResponse.json({ error: "invalid_range", message: range.error }, { status: 400 });
  }
  const accountId = url.searchParams.get("account");
  if (!accountId) {
    return NextResponse.json({ error: "missing_account" }, { status: 400 });
  }

  const result = await getAccountEvents(accountId, range.start, range.end);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!result.ok) {
    return NextResponse.json({ events: [], warnings: [{ email: result.email, message: result.message }] });
  }
  return NextResponse.json({
    events: result.events.map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() })),
    warnings: [],
  });
}
