import { NextRequest, NextResponse } from "next/server";
import { cancelNudge } from "@/lib/nudge/service";

export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const res = await cancelNudge(id);
  if (!res.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ deleted: id });
}
