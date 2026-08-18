import { hmacHex, safeEqual } from "@/lib/auth/session";
import { PUBLIC_BASE_URL } from "@/lib/env";

// A booking's self-serve manage link is stateless: the URL carries the booking
// id plus an HMAC of that id (keyed on PRIVATE_AUTH_SECRET). No token column /
// DB migration — the signature is unforgeable because the secret is server-only,
// and it's namespaced ("manage:") so it can't be confused with a session token.
function manageSecret(): string {
  // In prod PRIVATE_AUTH_SECRET is always set; the fallback only keeps local dev
  // self-consistent (sign and verify use the same value).
  return process.env.PRIVATE_AUTH_SECRET ?? "dev-insecure-manage-secret";
}

/// Signature for a booking's manage link.
export function signManageToken(bookingId: string): Promise<string> {
  return hmacHex(manageSecret(), `manage:${bookingId}`);
}

/// True iff `token` is the valid signature for `bookingId`.
export async function verifyManageToken(
  bookingId: string,
  token: string | undefined | null
): Promise<boolean> {
  if (!token) return false;
  const expected = await signManageToken(bookingId);
  return safeEqual(token, expected);
}

/// The full attendee-facing manage URL for a booking.
export function buildManageUrl(bookingId: string, token: string): string {
  return `${PUBLIC_BASE_URL}/manage/${bookingId}?t=${token}`;
}
