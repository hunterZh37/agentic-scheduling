import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

/// Which Google identities may sign in to the private dashboard.
///
/// Explicit allowlist first (OWNER_LOGIN_EMAILS, comma-separated). If it isn't
/// set we fall back to the destination account's address — the single calendar
/// bookings are written to, i.e. definitionally the owner's. Both sources are
/// server-controlled; nothing a visitor sends can widen them.
///
/// Returns an empty list when neither is available, and callers MUST treat that
/// as "deny": an unset allowlist must never mean "allow anyone".
export async function allowedLoginEmails(): Promise<string[]> {
  const configured = optionalEnv("OWNER_LOGIN_EMAILS");
  if (configured) {
    return configured
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }
  const destination = await prisma.account.findFirst({ where: { isDestination: true } });
  return destination ? [destination.email.trim().toLowerCase()] : [];
}

/// Whether this Google-verified email belongs to the owner. Comparison is
/// case-insensitive because providers don't normalise the local part.
export async function isOwnerEmail(email: string): Promise<boolean> {
  const allowed = await allowedLoginEmails();
  if (allowed.length === 0) return false; // fail closed
  return allowed.includes(email.trim().toLowerCase());
}
