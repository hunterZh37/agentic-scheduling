/// Sanitize the login flow's ?next= parameter to a same-site path.
///
/// `next.startsWith("/")` alone is NOT enough: browsers resolve a
/// protocol-relative "//evil.com" (and, in some parsers, "/\evil.com")
/// against the current scheme, so `window.location.href = next` would leave
/// the site right after a successful sign-in — an open redirect hanging off a
/// real auth action, which is exactly the pattern phishing kits and domain
/// reputation scanners look for. Accept a path only when it starts with a
/// single "/" followed by neither "/" nor "\"; anything else falls back home.
export function safeNextPath(next: string | undefined | null): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}
