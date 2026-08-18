"use client";

import { useEffect, useState } from "react";
import styles from "./AccountSection.module.css";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "ok" } | { kind: "error"; message: string };

/// Account controls inside the Manage sheet: change the login password (stored
/// hashed in the DB, no redeploy needed) and sign out.
export function AccountSection() {
  const [open, setOpen] = useState(false);
  const [hasCustom, setHasCustom] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (!open || hasCustom !== null) return;
    fetch("/api/settings/password")
      .then((r) => (r.ok ? r.json() : { hasCustomPassword: false }))
      .then((d) => setHasCustom(Boolean(d.hasCustomPassword)))
      .catch(() => setHasCustom(false));
  }, [open, hasCustom]);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status.kind === "saving") return;
    if (next.length < 8) {
      setStatus({ kind: "error", message: "New password must be at least 8 characters." });
      return;
    }
    if (next !== confirm) {
      setStatus({ kind: "error", message: "New passwords don't match." });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.ok) {
        setStatus({ kind: "ok" });
        setHasCustom(true);
        reset();
        return;
      }
      const data = await res.json().catch(() => ({}));
      const message =
        res.status === 403
          ? "Current password is incorrect."
          : data.message || "Couldn't update the password. Try again.";
      setStatus({ kind: "error", message });
    } catch {
      setStatus({ kind: "error", message: "Network error. Try again." });
    }
  };

  const signOut = async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.label}>ACCOUNT</span>
        <button className={styles.signout} onClick={signOut}>Sign out</button>
      </div>

      {!open ? (
        <button className={styles.link} onClick={() => setOpen(true)}>
          Change password
        </button>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <input
            className={styles.input}
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
            autoFocus
          />
          <input
            className={styles.input}
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="New password (min 8 chars)"
            autoComplete="new-password"
          />
          <input
            className={styles.input}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />
          {status.kind === "error" && <p className={styles.error}>{status.message}</p>}
          {status.kind === "ok" && <p className={styles.ok}>Password updated.</p>}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => {
                setOpen(false);
                reset();
                setStatus({ kind: "idle" });
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.save}
              disabled={status.kind === "saving" || !current || !next || !confirm}
            >
              {status.kind === "saving" ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
