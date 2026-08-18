import { cookies } from "next/headers";
import { optionalEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { COOKIE_NAME, verifyCoHostSession } from "@/lib/auth/session";

/// The co-host owning the current request's session, or null.
///
/// Server-side counterpart to the proxy's co-host gate: the proxy decides
/// whether a request may reach a /cohost route; this resolves WHO that co-host
/// is so pages and route handlers can scope their data. It verifies the cookie
/// signature again (never trusts a header the proxy might have set) and then
/// confirms the row still exists — a co-host the owner deleted has no session.
///
/// In local dev with no PRIVATE_AUTH_SECRET the gate is open, so there is no
/// co-host identity to resolve; returns null.
export async function currentCoHost(): Promise<{
  id: string;
  email: string;
  name: string;
  timezone: string;
} | null> {
  const secret = optionalEnv("PRIVATE_AUTH_SECRET");
  if (!secret) return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const coHostId = await verifyCoHostSession(secret, token, nowSeconds);
  if (!coHostId) return null;
  return prisma.coHost.findUnique({
    where: { id: coHostId },
    select: { id: true, email: true, name: true, timezone: true },
  });
}
