"use client";

import { useEffect, useState } from "react";
import { renderInline } from "@/components/agent/markdown";
import styles from "./EventModal.module.css";

/// One follow-up actionable row (shape returned by /api/followups).
export interface FollowupRow {
  id: string;
  eventKey: string;
  title: string;
  done: boolean;
  sortOrder: number;
}

/// Follow-ups section for the event modal: self-loads its occurrence's list and
/// handles add / toggle-done / delete. Optimistic updates; a failed write just
/// leaves the optimistic state (a follow-up is cheap to re-add) — no dialogs.
/// `onChanged` fires AFTER each write resolves so a parent (the agenda) can
/// refetch without racing the in-flight request.
export function EventFollowups({ eventKey, onChanged }: { eventKey: string; onChanged?: () => void }) {
  const [items, setItems] = useState<FollowupRow[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch(`/api/followups?eventKey=${encodeURIComponent(eventKey)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setItems((d.followups ?? []) as FollowupRow[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [eventKey]);

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    try {
      const res = await fetch("/api/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventKey, title }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.followup) {
        setItems((prev) => [...prev, d.followup as FollowupRow]);
        onChanged?.();
      }
    } catch {
      /* leave the input cleared; user can re-add */
    }
  };

  const toggle = (id: string, done: boolean) => {
    setItems((prev) => prev.map((f) => (f.id === id ? { ...f, done } : f)));
    void fetch(`/api/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    }).then(() => onChanged?.());
  };

  const remove = (id: string) => {
    setItems((prev) => prev.filter((f) => f.id !== id));
    void fetch(`/api/followups/${id}`, { method: "DELETE" }).then(() => onChanged?.());
  };

  return (
    <div className={styles.followups}>
      <div className={styles.followHead}>Follow-ups</div>
      {items.map((f) => (
        <div key={f.id} className={styles.followItem}>
          <button
            className={styles.followCheck}
            data-done={f.done}
            onClick={() => toggle(f.id, !f.done)}
            aria-label={f.done ? "Mark not done" : "Mark done"}
          >
            {f.done ? "✓" : ""}
          </button>
          <span className={styles.followTitle} data-done={f.done}>
            {renderInline(f.title, f.id)}
          </span>
          <button className={styles.followDelete} onClick={() => remove(f.id)} aria-label="Delete follow-up">
            ×
          </button>
        </div>
      ))}
      <input
        className={styles.followInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        placeholder="+ add follow-up"
      />
    </div>
  );
}
