import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentCoHost } from "@/lib/auth/coHostSession";

export const runtime = "nodejs";

// The signed-in co-host's own connected calendars. The proxy already gates this
// route to a valid co-host session; we resolve WHICH co-host here and scope
// every row to them, so one co-host can never see another's — or the owner's —
// calendars. Never exposes tokens.
export async function GET(): Promise<NextResponse> {
  const coHost = await currentCoHost();
  if (!coHost) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const accounts = await prisma.account.findMany({
    where: { coHostId: coHost.id },
    orderBy: { email: "asc" },
  });
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      provider: a.provider,
      checkForConflicts: a.checkForConflicts,
      connected: Boolean(a.refreshToken || a.accessToken),
      connectUrl: `/api/oauth/${a.provider}/start`,
    })),
  });
}
