import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentCoHost } from "@/lib/auth/coHostSession";

export const runtime = "nodejs";

// Disconnect one of the signed-in co-host's own calendars. Scoped to the
// session's co-host: an id that belongs to the owner or another co-host reads as
// 404, so this can only ever delete the caller's own account row + its tokens.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const coHost = await currentCoHost();
  if (!coHost) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const account = await prisma.account.findFirst({
    where: { id, coHostId: coHost.id },
  });
  if (!account) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await prisma.account.delete({ where: { id: account.id } });
  return NextResponse.json({ deleted: account.id });
}
