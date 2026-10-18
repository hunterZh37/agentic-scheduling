import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { endSeriesAt } from "@/lib/calendar/write";
import { parseIsoDate } from "@/lib/validation";

export const runtime = "nodejs";

/// PRIVATE. End a recurring series: occurrences after `at` (default: now)
/// stop, the ones before stay. `[id]` is the series id an occurrence carries
/// as `seriesId` in /api/schedule. Deleting the series master instead would
/// erase the past occurrences too.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: { accountEmail?: string; at?: string };
  try {
    body = (await req.json()) as { accountEmail?: string; at?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.accountEmail || typeof body.accountEmail !== "string") {
    return NextResponse.json({ error: "missing_account", message: "accountEmail is required." }, { status: 400 });
  }
  const account = await prisma.account.findFirst({ where: { email: body.accountEmail } });
  if (!account) {
    return NextResponse.json({ error: "unknown_account", message: `No connected account for ${body.accountEmail}.` }, { status: 404 });
  }
  const at = body.at === undefined ? new Date() : parseIsoDate(body.at);
  if (!at) {
    return NextResponse.json({ error: "invalid_input", message: "at must be ISO 8601." }, { status: 400 });
  }
  try {
    await endSeriesAt(account, id, at);
    return NextResponse.json({ ok: true, series: id, endedAt: at.toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "series_end_failed", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
