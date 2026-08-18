"use client";

import { useState } from "react";
import styles from "./login.module.css";
import { safeNextPath } from "@/lib/auth/safeNext";

// The break-glass password path, split out of the page so the page itself can
// stay a server component.
//
// This is the ONLY genuinely interactive part of the login screen, and keeping
// it here is what lets the identity copy around it be server-rendered. That
// matters beyond tidiness: when the whole page was a client component behind
// `<Suspense fallback={null}>`, the served HTML was an empty shell, so a
// crawler that does not run JS saw a blank page at the domain's front door —
// on a young domain, exactly the shape of a credential-harvesting site. See
// docs/REGRESSIONS.md.
export function PasswordFallback({ next }: { next: string }) {
  // Collapsed rather than removed: Google sign-in is the way in, but if it is
  // ever unreachable or the allowlist is misconfigured, deleting this outright
  // would leave no way back into the site.
  const [shown, setShown] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Full navigation so the proxy re-runs with the new cookie.
        window.location.href = safeNextPath(next);
        return;
      }
      setError(res.status === 401 ? "Incorrect password." : "Something went wrong. Try again.");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!shown) {
    return (
      <button type="button" className={styles.altLink} onClick={() => setShown(true)}>
        Use a password instead
      </button>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className={styles.divider}>
        <span>or use your password</span>
      </div>
      <input
        className={styles.input}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        autoFocus
        autoComplete="current-password"
      />
      {error && <p className={styles.error}>{error}</p>}
      <button className={styles.button} type="submit" disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
