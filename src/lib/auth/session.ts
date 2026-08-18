// Single-user session auth. The whole scheme is a signed, expiring cookie — no
// server-side session store. The cookie value is `<expiryUnixSeconds>.<hmac>`,
// where hmac = HMAC-SHA256(PRIVATE_AUTH_SECRET, expiry). Because the secret is
// server-only, the cookie can't be forged; the expiry makes it self-limiting.
//
// Implemented with Web Crypto (crypto.subtle) so the SAME code runs in the Edge
// middleware and in the Node route handlers — no Buffer, no node:crypto.

export const COOKIE_NAME = "session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
// Renew the cookie once it's past its halfway point. Combined with the proxy
// re-issuing on every authenticated request, this makes the session "sliding":
// as long as you use the app at least once per (TTL/2) window, you never get
// logged out. A truly idle session still expires after SESSION_TTL_SECONDS.
export const SESSION_RENEW_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

// Cookie attributes shared by the login route (initial set) and the proxy
// (sliding renewal) so the two can never drift apart.
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Length-independent constant-time-ish string compare (avoids leaking match
// position via early return). Both inputs are hex/opaque of fixed length here.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

/// Mint a session cookie value valid for SESSION_TTL_SECONDS from now.
export async function makeSessionToken(secret: string, nowSeconds: number): Promise<string> {
  const exp = String(nowSeconds + SESSION_TTL_SECONDS);
  const sig = await hmacHex(secret, exp);
  return `${exp}.${sig}`;
}

/// Verify a session cookie: signature must match AND not be expired.
export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  nowSeconds: number
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < nowSeconds) return false;
  const expected = await hmacHex(secret, exp);
  return safeEqual(sig, expected);
}

/// Read the expiry (unix seconds) out of a cookie value without verifying it.
/// Returns null for missing/malformed tokens. Callers that trust the value must
/// verify the signature separately (see verifySessionToken).
export function sessionExpirySeconds(token: string | undefined): number | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const expNum = Number(token.slice(0, dot));
  return Number.isFinite(expNum) ? expNum : null;
}

/// True when a (already-verified) token has aged past its renewal point and the
/// proxy should mint a fresh one to slide the window forward.
export function sessionNeedsRenewal(token: string | undefined, nowSeconds: number): boolean {
  const exp = sessionExpirySeconds(token);
  if (exp === null) return false;
  const issuedAt = exp - SESSION_TTL_SECONDS;
  return nowSeconds - issuedAt >= SESSION_RENEW_AFTER_SECONDS;
}

/// Constant-time compare for the login password check.
export function passwordMatches(input: string, expected: string): boolean {
  return safeEqual(input, expected);
}
