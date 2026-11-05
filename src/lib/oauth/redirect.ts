import { OAUTH_BASE_URL } from "@/lib/env";

/// The callback a calendar CONNECT returns to: always on the sign-in host.
///
/// A connect is a round trip. Our start route sets a CSRF cookie, the provider
/// sends the browser back to this URL, and the callback checks the cookie and
/// reads the session to learn whose calendar it is. Both cookies are host-only,
/// so the callback has to be on the host the flow started on, which is the host
/// the dashboard and the co-host page are used on: OAUTH_BASE_URL.
///
/// This used to be its own env var (GOOGLE_OAUTH_REDIRECT_URI,
/// MS_OAUTH_REDIRECT_URI). In production those still named the vercel.app
/// deployment domain after sign-in moved to the custom domain on 2026-10-07,
/// and from then on no calendar could be connected: the callback ran on a host
/// that had neither cookie. Two settings that must agree are one setting, so
/// the vars are no longer read. See docs/REGRESSIONS.md.
export function connectRedirectUri(provider: "google" | "microsoft"): string {
  return new URL(`/api/oauth/${provider}/callback`, OAUTH_BASE_URL).toString();
}
