"use client";

import { useState } from "react";
import { renderInline } from "@/components/agent/markdown";
import { progress, progressLabel } from "@/lib/todos/items";
import styles from "./EventModal.module.css";

export interface TodoItemRow {
  id: string;
  title: string;
  done: boolean;
}

/// The to-do list under an actionable, in the detail panel's VIEW mode: check
/// off, remove, quick-add. Optimistic; a failed write leaves the optimistic
/// state (an item is cheap to re-add). `onChanged` fires after each write so
/// the agenda can refetch its "1 of 3" pill. Replaced follow-ups 2026-09-24.
export function TodoItems({
  todoId,
  items,
  onItemsChange,
  onChanged,
  onPendingChange,
}: {
  todoId: string;
  /// Controlled: the modal owns the list so its header count and the editor
  /// stay in step with what was just checked or added here.
  items: TodoItemRow[];
  onItemsChange: (next: TodoItemRow[]) => void;
  onChanged?: () => void;
  /// Number of adds still waiting on the server. The modal keeps Edit closed
  /// while this is above zero: the editor saves a full replacement list, and
  /// an item it never saw would be deleted by that save.
  onPendingChange?: (pending: number) => void;
}) {
  const setItems = (fn: (prev: TodoItemRow[]) => TodoItemRow[]) => onItemsChange(fn(items));
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(0);
  const bump = (d: number) =>
    setPending((n) => {
      const next = n + d;
      onPendingChange?.(next);
      return next;
    });
  const label = progressLabel(progress(items));

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    bump(1);
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(todoId)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.item) {
        setItems((prev) => [...prev, d.item as TodoItemRow]);
        onChanged?.();
      }
    } catch {
      /* input already cleared; the owner can re-add */
    } finally {
      bump(-1);
    }
  };

  const toggle = (id: string, done: boolean) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, done } : i)));
    void fetch(`/api/todos/${encodeURIComponent(todoId)}/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    }).then(() => onChanged?.());
  };

  const remove = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    void fetch(`/api/todos/${encodeURIComponent(todoId)}/items/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
      () => onChanged?.()
    );
  };

  return (
    <div className={styles.todoList}>
      <div className={styles.todoHead}>
        <span>To-do list</span>
        {label && <span className={`${styles.todoProgress} tnum`}>{label} done</span>}
      </div>
      {items.map((i) => (
        <div key={i.id} className={styles.todoItem}>
          <button
            className={styles.todoCheck}
            data-done={i.done}
            onClick={() => toggle(i.id, !i.done)}
            aria-pressed={i.done}
            aria-label={i.done ? "Mark not done" : "Mark done"}
          >
            {i.done && (
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M2.5 6.2 L5 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <span className={styles.todoTitle} data-done={i.done}>
            {renderInline(i.title, i.id)}
          </span>
          <button className={styles.todoDelete} onClick={() => remove(i.id)} aria-label="Remove item">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <input
        className={styles.todoInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        placeholder="+ add item"
        aria-label="Add a to-do item"
      />
    </div>
  );
}

/// The same list in the panel's EDIT mode: plain text rows the owner can
/// retitle, remove, or extend; saved with the actionable as one replacement
/// list (PATCH /api/todos/[id] `items`). Done state is kept, not editable here.
export function TodoItemsEditor({
  items,
  onChange,
}: {
  items: { id?: string; title: string; done: boolean }[];
  onChange: (next: { id?: string; title: string; done: boolean }[]) => void;
}) {
  return (
    <div className={styles.todoEditor}>
      <label className={styles.fLabel}>To-do list</label>
      {items.map((it, idx) => (
        <div key={it.id ?? `new-${idx}`} className={styles.todoEditRow}>
          <input
            className={styles.fInput}
            value={it.title}
            onChange={(e) => onChange(items.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))}
            placeholder="Item"
            aria-label={`To-do item ${idx + 1}`}
          />
          <button
            type="button"
            className={styles.todoDelete}
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
            aria-label="Remove item"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.todoAddRow}
        onClick={() => onChange([...items, { title: "", done: false }])}
      >
        + add item
      </button>
    </div>
  );
}
