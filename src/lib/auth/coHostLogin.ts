import { prisma } from "@/lib/db";

/// A registered co-host, looked up by their Google-verified sign-in email.
///
/// Unlike the owner allowlist (env / destination account), co-hosts are rows in
/// the CoHost table: someone is a co-host only if the owner invited them and the
/// row exists. Comparison is case-insensitive because providers don't normalise
/// the local part; CoHost.email is stored lowercased at write time.
///
/// Returns null for any address that isn't a co-host — the caller MUST treat
/// that as "deny", same fail-closed contract as isOwnerEmail.
export async function coHostForEmail(
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const coHost = await prisma.coHost.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, name: true },
  });
  return coHost;
}
