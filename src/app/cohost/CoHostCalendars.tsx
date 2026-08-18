"use client";

import { useEffect, useState } from "react";

interface AccountRow {
  id: string;
  email: string;
  provider: string;
  connected: boolean;
  connectUrl: string;
}

// Theme tokens (globals.css), not hard-coded hex, so it reads correctly in the
// dark dashboard as well as light.
const S: Record<string, React.CSSProperties> = {
  section: { marginTop: 32 },
  h2: { fontSize: 18, margin: "0 0 4px", letterSpacing: "-0.01em", color: "var(--text-1)" },
  hint: { color: "var(--text-2)", fontSize: 14, margin: "0 0 16px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    border: "1px solid var(--hairline)",
    borderRadius: 12,
    marginBottom: 8,
    background: "var(--surface)",
  },
  email: { fontSize: 15, fontWeight: 500, color: "var(--text-1)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  status: { fontSize: 13, color: "var(--text-3)" },
  remove: {
    border: "none",
    background: "transparent",
    color: "var(--text-3)",
    fontSize: 13,
    cursor: "pointer",
    padding: "4px 6px",
  },
  removeArmed: { color: "var(--state-cancelled)", fontWeight: 600 },
  reconnect: { fontSize: 13, color: "var(--accent)", textDecoration: "none" },
  add: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    padding: "10px 16px",
    borderRadius: 10,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 500,
    textDecoration: "none",
  },
  empty: { color: "var(--text-3)", fontSize: 14, padding: "8px 0 4px" },
  error: { color: "var(--state-cancelled)", fontSize: 13, marginTop: 10 },
  notice: { color: "#34c759", fontSize: 13, marginTop: 10 },
};

const dotStyle = (ok: boolean): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
  background: ok ? "#34c759" : "var(--text-3)",
});

export function CoHostCalendars() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/cohost/accounts")
      .then((r) => r.json())
      .then((d) => setAccounts(d.accounts ?? []))
      .catch(() => setError("Couldn't load your calendars."))
      .finally(() => setLoading(false));
  }, []);

  // Surface the OAuth return status (the connect callback redirects back to
  // /cohost?oauth=google&status=connected) and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (status === "connected") {
      const email = params.get("email");
      setNotice(email ? `Connected ${email}.` : "Calendar connected.");
    } else if (status === "error") {
      setError("That calendar didn't connect. Please try again.");
    }
    if (status) window.history.replaceState({}, "", "/cohost");
  }, []);

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/cohost/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Couldn't remove that calendar.");
        setConfirmingId(null);
        return;
      }
      setAccounts((rows) => rows.filter((r) => r.id !== id));
      setConfirmingId(null);
      setError(null);
    } catch {
      setError("Couldn't remove that calendar.");
      setConfirmingId(null);
    }
  };

  return (
    <div style={S.section}>
      <h2 style={S.h2}>Your calendars</h2>
      <p style={S.hint}>
        Connect the calendars you want checked for conflicts. They stay private to
        you: the owner never sees them, only whether you&apos;re free.
      </p>

      {!loading && accounts.length === 0 && (
        <p style={S.empty}>No calendars connected yet.</p>
      )}

      {accounts.map((a) => (
        <div key={a.id} style={S.row}>
          <span style={dotStyle(a.connected)} aria-hidden />
          <span style={S.email}>{a.email}</span>
          {a.connected ? (
            <span style={S.status}>Connected</span>
          ) : (
            <a style={S.reconnect} href={a.connectUrl}>
              Reconnect
            </a>
          )}
          <button
            style={{ ...S.remove, ...(confirmingId === a.id ? S.removeArmed : {}) }}
            onClick={() => (confirmingId === a.id ? remove(a.id) : setConfirmingId(a.id))}
            onBlur={() => setConfirmingId((cur) => (cur === a.id ? null : cur))}
          >
            {confirmingId === a.id ? "Confirm remove" : "Remove"}
          </button>
        </div>
      ))}

      <a style={S.add} href="/api/oauth/google/start">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Connect a Google calendar
      </a>

      {error && <p style={S.error}>{error}</p>}
      {notice && <p style={S.notice}>{notice}</p>}
    </div>
  );
}
