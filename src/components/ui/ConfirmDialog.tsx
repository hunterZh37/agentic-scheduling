"use client";

import { useEffect } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  /// Short question, e.g. 'Delete "Gym"?'.
  title: string;
  /// Optional second line, e.g. "This can't be undone.".
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /// When true, the confirm button uses the destructive (red) treatment.
  danger?: boolean;
  /// Disables both buttons and shows a busy label while the action runs.
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/// A small, focused yes/no modal. Backdrop click and Escape both cancel. Used
/// for irreversible actions (deleting an event or a reserved block).
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div className={styles.overlay} onClick={() => !busy && onCancel()}>
      <div className={styles.card} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className={styles.title}>{title}</p>
        {body && <p className={styles.body}>{body}</p>}
        <div className={styles.btns}>
          <button className={styles.ghost} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={danger ? styles.danger : styles.primary}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
