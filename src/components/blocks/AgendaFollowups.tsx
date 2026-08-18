"use client";

import { useState } from "react";
import type { FollowupRow } from "@/components/calendar/EventFollowups";
import { renderInline } from "@/components/agent/markdown";
import ReminderControl from "@/components/reminders/ReminderControl";
import styles from "./BlocksPane.module.css";

/// Inline follow-ups shown under an event row in the agenda: a compact checkable
/// list plus a quick-add. Presentational — the parent owns the data (the map in
/// BlocksPane) and the persistence; this only renders and collects input.
export function AgendaFollowups({
  items,
  onToggle,
  onDelete,
  onAdd,
}: {
  items: FollowupRow[];
  onToggle: (id: string, done: boolean) => void;
  onDelete: (id: string) => void;
  onAdd: (title: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const t = draft.trim();
    if (t) onAdd(t);
    setDraft("");
    setAdding(false);
  };

  return (
    <li className={styles.followRow}>
      {items.map((f) => (
        <div key={f.id} className={styles.followItem}>
          <button
            className={styles.followCheck}
            data-done={f.done}
            onClick={() => onToggle(f.id, !f.done)}
            aria-label={f.done ? "Mark not done" : "Mark done"}
          >
            {f.done ? "✓" : ""}
          </button>
          <span className={styles.followTitle} data-done={f.done}>
            {renderInline(f.title, f.id)}
          </span>
          <ReminderControl title={f.title} startISO={null} itemRef={{ kind: "followup", id: f.id }} />
          <button className={styles.followDel} onClick={() => onDelete(f.id)} aria-label="Delete follow-up">
            ×
          </button>
        </div>
      ))}
      {adding ? (
        <input
          autoFocus
          className={styles.followInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          onBlur={submit}
          placeholder="follow-up…"
        />
      ) : (
        <button className={styles.followAddBtn} onClick={() => setAdding(true)}>
          + follow-up
        </button>
      )}
    </li>
  );
}
