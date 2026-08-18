"use client";

import { useEffect, useState } from "react";
import { accountVar } from "@/lib/design/accounts";
import { AccountSection } from "@/components/private/AccountSection";
import styles from "./CalendarsManager.module.css";

interface AccountRow {
  id: string;
  email: string;
  displayName: string | null;
  visible: boolean;
  connected: boolean;
  connectUrl: string;
  /// The calendar every new booking is written to. Exactly one account holds it.
  isDestination: boolean;
}

export function CalendarsManager({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The account whose Remove button is armed (awaiting a confirming second click).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => setAccounts(d.accounts ?? []));
  }, []);

  const patch = async (id: string, body: Partial<Pick<AccountRow, "displayName" | "visible">>) => {
    let previous: AccountRow | undefined;
    setAccounts((rows) => {
      previous = rows.find((r) => r.id === id);
      return rows.map((r) => (r.id === id ? { ...r, ...body } : r));
    });
    try {
      const res = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save_failed");
      setError(null);
    } catch {
      if (previous) {
        const restored = previous;
        setAccounts((rows) => rows.map((r) => (r.id === id ? restored : r)));
      }
      setError("Couldn't save that change. Please try again.");
    }
  };

  // Remove (disconnect) an account. Two-click confirm via `confirmingId`. The
  // server refuses the destination account (409) — surface its message.
  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? "Couldn't remove that account.");
        setConfirmingId(null);
        return;
      }
      setAccounts((rows) => rows.filter((r) => r.id !== id));
      setEditingId((cur) => (cur === id ? null : cur));
      setConfirmingId(null);
      setError(null);
    } catch {
      setError("Couldn't remove that account. Please try again.");
      setConfirmingId(null);
    }
  };

  // Move where new bookings are written. The API does this in a transaction and
  // refuses a calendar with no stored credentials (409), which would otherwise
  // accept a booking and fail on the event insert — after the visitor has been
  // told they are booked. Surface that message rather than a generic error.
  const makeDestination = async (id: string) => {
    const previous = accounts;
    setAccounts((rows) => rows.map((r) => ({ ...r, isDestination: r.id === id })));
    setEditingId(null);
    try {
      const res = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDestination: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAccounts(previous);
        setError(body.message ?? "Couldn't move the booking calendar.");
        return;
      }
      setError(null);
    } catch {
      setAccounts(previous);
      setError("Couldn't move the booking calendar. Please try again.");
    }
  };

  const startEdit = (a: AccountRow) => {
    setEditingId(a.id);
    setDraftName(a.displayName ?? "");
    setConfirmingId(null);
  };
  const commitEdit = (a: AccountRow) => {
    const name = draftName.trim();
    setEditingId(null);
    setConfirmingId(null);
    if ((a.displayName ?? "") !== name) void patch(a.id, { displayName: name || null });
  };

  const connectedCount = accounts.filter((a) => a.connected).length;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            Calendars <span className={styles.count}>{connectedCount} connected</span>
          </h3>
          <a className={styles.addBtn} href="/api/oauth/google/start" aria-label="Connect a calendar">+</a>
        </div>

        {error && (
          <p style={{ color: "var(--danger, #e5484d)", fontSize: "var(--type-caption)", margin: "0 0 var(--space-2)" }}>
            {error}
          </p>
        )}

        <ul className={styles.list}>
          {accounts.map((a) => {
            const editing = editingId === a.id;
            return (
              <li key={a.id} className={`${styles.row} ${editing ? styles.rowEditing : ""}`}>
                <div className={styles.rowMain}>
                  {/* The coloured square is an inner element so the BUTTON can
                      carry a full 44px touch target on a phone while the swatch
                      itself stays 22px. */}
                  <button
                    className={styles.swatch}
                    onClick={() => void patch(a.id, { visible: !a.visible })}
                    aria-pressed={a.visible}
                    aria-label={a.visible ? "Hide calendar" : "Show calendar"}
                  >
                    <span
                      className={styles.swatchBox}
                      style={{
                        background: a.visible ? `var(${accountVar(a.email)})` : "transparent",
                        borderColor: `var(${accountVar(a.email)})`,
                      }}
                    >
                      {a.visible && <span className={styles.tick}>✓</span>}
                    </span>
                  </button>

                  {editing ? (
                    <input
                      className={styles.editInput}
                      value={draftName}
                      autoFocus
                      placeholder={a.email}
                      aria-label={`Name for ${a.email}`}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(a);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <div className={styles.nameWrap}>
                      <span className={styles.name}>
                        <span className={styles.nameText}>{a.displayName || a.email}</span>
                        {/* Which calendar visitors' bookings land on was invisible
                            here, and it is the one thing about a calendar that
                            affects someone other than the owner. */}
                        {a.isDestination && <span className={styles.destBadge}>Bookings</span>}
                      </span>
                      {a.displayName && <span className={styles.subEmail}>{a.email}</span>}
                    </div>
                  )}

                  {editing ? (
                    <button className={styles.btnPrimary} onClick={() => commitEdit(a)}>
                      Done
                    </button>
                  ) : a.connected ? (
                    <button
                      className={styles.more}
                      onClick={() => startEdit(a)}
                      aria-label={`Settings for ${a.displayName || a.email}`}
                      title="Rename, remove, or send bookings here"
                    >
                      ⋯
                    </button>
                  ) : (
                    <a className={styles.btnPrimary} href={a.connectUrl}>
                      Connect
                    </a>
                  )}
                </div>

                {/* The actions get their own line. Inline, they collided with the
                    name into one run of same-weight text — "Send bookings here
                    Remove Done" read as a sentence, not as three controls. */}
                {editing && (
                  <div className={styles.editActions}>
                    <span className={styles.editEmail}>{a.email}</span>
                    <span className={styles.spacer} />
                    {a.connected && !a.isDestination && (
                      <button className={styles.btn} onClick={() => void makeDestination(a.id)}>
                        Send bookings here
                      </button>
                    )}
                    {confirmingId === a.id ? (
                      <button className={styles.btnDanger} onClick={() => void remove(a.id)} autoFocus>
                        Remove?
                      </button>
                    ) : (
                      <button
                        className={styles.iconDanger}
                        onClick={() => setConfirmingId(a.id)}
                        aria-label={`Remove ${a.displayName || a.email}`}
                        title="Remove this calendar"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <AccountSection />
      </div>
    </div>
  );
}
