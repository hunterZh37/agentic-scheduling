import { HOST } from "@/lib/booking/publicConfig";
import { safeNextPath } from "@/lib/auth/safeNext";
import { PasswordFallback } from "./PasswordFallback";
import styles from "./login.module.css";

// Owner sign-in. A SERVER component on purpose.
//
// Everything a visitor (or a web-reputation crawler) needs to identify this
// site — whose it is, what it is for, and the way through to the public pages —
// must be in the HTML the server sends, not painted in later by React. This
// page used to be `"use client"` in its entirety, wrapped in
// `<Suspense fallback={null}>` because it read useSearchParams; the served HTML
// was therefore an empty body. Combined with `/` redirecting here, a crawler's
// whole impression of a four-week-old domain was "blank page that wants a
// login" — and FortiGuard rated the domain Phishing twice on that basis.
// Keep the identity copy server-rendered. See docs/REGRESSIONS.md.

export const metadata = {
  title: "Sign in",
  description: `Owner sign-in for ${HOST.name}'s consulting booking site. Visitors can book a time without an account.`,
};

// Surfaced by the Google callback when sign-in is refused, so a rejected
// attempt explains itself instead of bouncing silently back to this form.
function oauthMessage(error: string | undefined): string | null {
  if (!error) return null;
  if (error === "not_authorized") return "That Google account isn't the owner of this site.";
  if (error === "auth_not_configured" || error === "login_allowlist_empty") {
    return "Google sign-in isn't configured yet.";
  }
  return "Google sign-in didn't complete. Try again.";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const message = oauthMessage(error);
  // Only same-site paths, so a crafted ?next= can't bounce a signed-in owner
  // off to another origin.
  const target = safeNextPath(next);

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Book with {HOST.name}</h1>
        <p className={styles.sub}>
          This is the private owner sign-in for {HOST.name}&apos;s personal consulting practice
          ({HOST.practice.domain}). Visitors do not need an account to book a time.
        </p>
        {message && <p className={styles.error}>{message}</p>}

        {/* Primary path. Proves identity through Google (inheriting whatever MFA
            that account enforces) and is restricted to the owner's address, so
            there's no shared secret to guess, phish or reuse. */}
        <a className={styles.google} href="/api/auth/google/start">
          Sign in with Google
        </a>

        <PasswordFallback next={target} />

        {/* Visitors (and web-reputation reviewers) land here because the root is
            auth-gated — give them the site's identity and a path to the public
            pages instead of a dead-end anonymous password box. */}
        <p className={styles.visitor}>
          Looking to meet with {HOST.name}? <a href="/book">Book a time</a>
        </p>
        <p className={styles.legal}>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
        </p>
      </div>
    </main>
  );
}
