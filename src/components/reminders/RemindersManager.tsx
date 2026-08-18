"use client";

import { useEffect, useState } from "react";
import styles from "./RemindersManager.module.css";

interface ReminderRow {
  id: string;
  whenLabel: string;
  body: string;
  recurring: boolean;
  eventKind: string | null;
  eventId: string | null;
}

/// Modal listing every upcoming reminder (nudge) across events, to-dos, and
/// follow-ups. Mirrors BirthdaysManager's overlay/sheet shell, minus the add
/// form — reminders are created from their originating item (EventModal,
/// to-do, follow-up), not here.
export function RemindersManager({ onClose }: { onClose: () => void }) {
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = () =>
    fetch("/api/reminders")
      .then((r) => r.json())
      .then((d) => setReminders((d.reminders ?? []) as ReminderRow[]))
      .catch(() => setReminders([]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const remove = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
      if (res.ok) setReminders((rows) => rows.filter((r) => r.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        <div className={styles.header}>
          <h3 className={styles.title}>
            Reminders <span className={styles.count}>{reminders.length}</span>
          </h3>
        </div>

        {loading ? (
          <p className={styles.empty}>Loading…</p>
        ) : reminders.length === 0 ? (
          <p className={styles.empty}>No reminders yet.</p>
        ) : (
          <ul className={styles.list}>
            {reminders.map((r) => (
              <li key={r.id} className={styles.row}>
                <span className={styles.rowLabel}>
                  🔔 {r.whenLabel} — {r.body}
                  {r.recurring && <span className={styles.repeats}>repeats</span>}
                </span>
                <button
                  className={styles.deleteBtn}
                  onClick={() => void remove(r.id)}
                  disabled={deletingId === r.id}
                  aria-label={`Delete reminder: ${r.body}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
