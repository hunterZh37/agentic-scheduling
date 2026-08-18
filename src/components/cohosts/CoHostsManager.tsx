"use client";

import { useEffect, useState } from "react";
import { COMMON_TIMEZONES } from "@/lib/booking/publicConfig";
import styles from "./CoHostsManager.module.css";
import { TeamLinks } from "./TeamLinks";

interface CoHostRow {
  id: string;
  email: string;
  name: string;
  timezone: string;
  linkedin: string | null;
  connectedCalendars: number;
}

const ERROR_COPY: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  invalid_name: "Add a name.",
  invalid_timezone: "That isn't a valid time zone.",
  invalid_linkedin: "LinkedIn must be a full URL (https://…).",
  already_cohost: "That address is already a co-host.",
};

/// Owner-only modal to invite and manage co-hosts. Creating a co-host is the
/// invite: that person can then sign in with the SAME Google address and land
/// on their own /cohost page to connect calendars. No email is sent — tell them
/// to sign in. Mirrors BirthdaysManager's overlay/sheet shell.
export function CoHostsManager({ onClose }: { onClose: () => void }) {
  const [coHosts, setCoHosts] = useState<CoHostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [linkedin, setLinkedin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Per-row edit drafts, keyed by co-host id.
  const [liDraft, setLiDraft] = useState<Record<string, string>>({});
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});
  const [emailDraft, setEmailDraft] = useState<Record<string, string>>({});
  const [invitedId, setInvitedId] = useState<string | null>(null);
  // Canonical sign-in URL from the server (APP_BASE_URL), so the invite always
  // points at the OAuth-registered domain, not this browser's current host.
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  const reload = () =>
    fetch("/api/cohosts")
      .then((r) => r.json())
      .then((d) => {
        setCoHosts((d.coHosts ?? []) as CoHostRow[]);
        if (typeof d.loginUrl === "string") setLoginUrl(d.loginUrl);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const canAdd = name.trim().length > 0 && email.trim().length > 0 && !saving;

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/cohosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          ...(timezone.trim() !== "" ? { timezone: timezone.trim() } : {}),
          ...(linkedin.trim() !== "" ? { linkedin: linkedin.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setName("");
        setEmail("");
        setTimezone("America/New_York");
        setLinkedin("");
        await reload();
      } else {
        setError(ERROR_COPY[body.error] ?? "Couldn't add that co-host.");
      }
    } catch {
      setError("Couldn't add that co-host.");
    } finally {
      setSaving(false);
    }
  };

  // Save a per-row NAME edit (PATCH). No-op when unchanged or emptied.
  const saveName = async (c: CoHostRow) => {
    const next = (nameDraft[c.id] ?? c.name).trim();
    if (!next || next === c.name) return;
    try {
      const res = await fetch(`/api/cohosts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        setCoHosts((rows) => rows.map((r) => (r.id === c.id ? { ...r, name: next } : r)));
        setError(null);
      } else {
        setError("Couldn't save that name.");
      }
    } catch {
      setError("Couldn't save that name.");
    }
  };

  // Save a per-row EMAIL edit (PATCH). Email is the co-host's Google login
  // identity, so this changes who signs in as them. No-op when unchanged.
  const saveEmail = async (c: CoHostRow) => {
    const next = (emailDraft[c.id] ?? c.email).trim().toLowerCase();
    if (!next || next === c.email) return;
    try {
      const res = await fetch(`/api/cohosts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setCoHosts((rows) => rows.map((r) => (r.id === c.id ? { ...r, email: next } : r)));
        setError(null);
      } else {
        setError(ERROR_COPY[body.error] ?? "Couldn't save that email.");
      }
    } catch {
      setError("Couldn't save that email.");
    }
  };

  // Save a per-row TIME ZONE change (PATCH), picked from the dropdown. No-op when
  // unchanged; the server validates it's a real IANA zone.
  const saveTimezone = async (c: CoHostRow, next: string) => {
    if (!next || next === c.timezone) return;
    try {
      const res = await fetch(`/api/cohosts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setCoHosts((rows) => rows.map((r) => (r.id === c.id ? { ...r, timezone: next } : r)));
        setError(null);
      } else {
        setError(ERROR_COPY[body.error] ?? "Couldn't save that time zone.");
      }
    } catch {
      setError("Couldn't save that time zone.");
    }
  };

  // Save a per-row LinkedIn edit (PATCH). Called on blur / Enter; a no-op when
  // the value hasn't changed.
  const saveLinkedin = async (c: CoHostRow) => {
    const next = (liDraft[c.id] ?? "").trim();
    if (next === (c.linkedin ?? "")) return;
    try {
      const res = await fetch(`/api/cohosts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedin: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setCoHosts((rows) => rows.map((r) => (r.id === c.id ? { ...r, linkedin: next || null } : r)));
        setError(null);
      } else {
        setError(ERROR_COPY[body.error] ?? "Couldn't save that LinkedIn URL.");
      }
    } catch {
      setError("Couldn't save that LinkedIn URL.");
    }
  };

  // Copy a ready-to-send invite so the co-host lands in the RIGHT place: the
  // sign-in page on this exact host (not the solo /book page, not a preview
  // URL), signing in with the SAME Google address they were added with.
  const copyInvite = async (c: CoHostRow) => {
    // Prefer the server's canonical login URL; fall back to this origin only if
    // it somehow didn't load.
    const url = loginUrl ?? `${window.location.origin}/login`;
    const text =
      `You're set up as a co-host on my scheduling page. To connect your calendar:\n` +
      `1. Go to ${url}\n` +
      `2. Click "Sign in with Google" and use ${c.email}\n` +
      `3. On your page, click "Connect a Google calendar"\n` +
      `That's it — your busy times will then be reflected in our shared booking link.`;
    try {
      await navigator.clipboard.writeText(text);
      setInvitedId(c.id);
      window.setTimeout(() => setInvitedId((cur) => (cur === c.id ? null : cur)), 1800);
    } catch {
      setError("Couldn't copy — the invite link is your site's /login page.");
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/cohosts/${id}`, { method: "DELETE" });
      if (res.ok) setCoHosts((rows) => rows.filter((c) => c.id !== id));
      else setError("Couldn't remove that co-host.");
    } catch {
      setError("Couldn't remove that co-host.");
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className={styles.header}>
          <h3 className={styles.title}>
            Co-hosts <span className={styles.count}>{coHosts.length}</span>
          </h3>
        </div>
        <p className={styles.blurb}>
          A co-host connects their own calendars so you can share a booking link
          that only offers times you&apos;re both free. Add them here, then tell
          them to sign in with this Google address.
        </p>

        <div className={styles.addCard}>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
          />
          <input
            className={styles.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Google email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
          />
          <select
            className={styles.input}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-label="Co-host time zone"
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            value={linkedin}
            onChange={(e) => setLinkedin(e.target.value)}
            placeholder="LinkedIn URL (optional)"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
          />
          <button className={styles.addBtn} onClick={() => void add()} disabled={!canAdd}>
            {saving ? "Adding…" : "Add co-host"}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </div>

        {loading ? (
          <p className={styles.empty}>Loading…</p>
        ) : coHosts.length === 0 ? (
          <p className={styles.empty}>No co-hosts yet.</p>
        ) : (
          <ul className={styles.list}>
            {coHosts.map((c) => (
              <li key={c.id} className={styles.row}>
                <span className={styles.rowMain}>
                  <input
                    className={styles.rowNameEdit}
                    value={nameDraft[c.id] ?? c.name}
                    onChange={(e) => setNameDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                    onBlur={() => void saveName(c)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    aria-label="Co-host name"
                  />
                  <input
                    className={styles.rowLinkedin}
                    type="email"
                    value={emailDraft[c.id] ?? c.email}
                    onChange={(e) => setEmailDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                    onBlur={() => void saveEmail(c)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    placeholder="Google email"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Co-host Google email"
                  />
                  <span
                    className={c.connectedCalendars > 0 ? styles.connOk : styles.connNone}
                  >
                    {c.connectedCalendars > 0
                      ? `${c.connectedCalendars} calendar${c.connectedCalendars > 1 ? "s" : ""} connected`
                      : "No calendar connected — they must sign in and connect one"}
                  </span>
                  <select
                    className={styles.rowSelect}
                    value={c.timezone}
                    onChange={(e) => void saveTimezone(c, e.target.value)}
                    aria-label="Co-host time zone"
                  >
                    {/* Ensure the current value is always selectable, even if it
                        isn't one of the common zones. */}
                    {Array.from(new Set([c.timezone, ...COMMON_TIMEZONES])).map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <input
                    className={styles.rowLinkedin}
                    value={liDraft[c.id] ?? c.linkedin ?? ""}
                    onChange={(e) => setLiDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                    onBlur={() => void saveLinkedin(c)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    placeholder="LinkedIn URL (optional)"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </span>
                <span className={styles.rowActions}>
                  <button
                    className={styles.inviteBtn}
                    onClick={() => void copyInvite(c)}
                    aria-label={`Copy ${c.name}'s invite`}
                  >
                    {invitedId === c.id ? "Copied invite" : "Copy invite"}
                  </button>
                  <button
                    className={`${styles.removeBtn} ${confirmingId === c.id ? styles.removeArmed : ""}`}
                    onClick={() => (confirmingId === c.id ? void remove(c.id) : setConfirmingId(c.id))}
                    onBlur={() => setConfirmingId((cur) => (cur === c.id ? null : cur))}
                    aria-label={`Remove ${c.name}`}
                  >
                    {confirmingId === c.id ? "Confirm remove" : "Remove"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <TeamLinks coHosts={coHosts} />
      </div>
    </div>
  );
}
