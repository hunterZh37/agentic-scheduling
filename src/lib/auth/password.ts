// App-login password hashing and verification.
//
// We store the login password as a PBKDF2-SHA256 hash (never plaintext). Like
// session.ts, this uses Web Crypto (crypto.subtle) rather than node:crypto so
// there's no native dependency, and crypto.getRandomValues for the salt.
//
// Encoded form (single opaque string stored in Settings.passwordHash):
//   pbkdf2$<iterations>$<saltHex>$<hashHex>
// The parameters travel with the hash, so iteration counts can be raised later
// without breaking existing hashes.

import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { passwordMatches } from "@/lib/auth/session";

const PBKDF2_ITERATIONS = 210_000; // OWASP-recommended floor for PBKDF2-SHA256.
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveHex(
  plain: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(plain), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8
  );
  return toHex(new Uint8Array(bits));
}

/// Hash a plaintext password into the encoded storage form.
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashHex = await deriveHex(plain, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hashHex}`;
}

/// Verify a plaintext password against an encoded hash. Returns false for any
/// malformed stored value rather than throwing.
export async function verifyPasswordHash(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  if (!/^[0-9a-f]+$/.test(parts[2]) || !/^[0-9a-f]+$/.test(parts[3])) return false;
  const computed = await deriveHex(plain, fromHex(parts[2]), iterations);
  // passwordMatches is a constant-time compare over equal-length hex strings.
  return passwordMatches(computed, parts[3]);
}

/// The effective login check. Priority:
///   1. A custom password hash stored in the DB (set in-app), else
///   2. the APP_PASSWORD env var, else
///   3. PRIVATE_AUTH_SECRET itself.
/// Returns false if nothing is configured (no secret) — caller handles that.
export async function verifyLoginPassword(plain: string): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (settings?.passwordHash) {
    return verifyPasswordHash(plain, settings.passwordHash);
  }
  const fallback = optionalEnv("APP_PASSWORD") ?? optionalEnv("PRIVATE_AUTH_SECRET");
  if (!fallback) return false;
  return passwordMatches(plain, fallback);
}

/// Persist a new login password (hashed). Upserts the singleton Settings row.
export async function setLoginPassword(plain: string): Promise<void> {
  const passwordHash = await hashPassword(plain);
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", passwordHash },
    update: { passwordHash },
  });
}

/// Whether a custom (DB-stored) password has been set, for the UI to show
/// "Change password" vs "Set a password".
export async function hasCustomPassword(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { passwordHash: true },
  });
  return Boolean(settings?.passwordHash);
}
