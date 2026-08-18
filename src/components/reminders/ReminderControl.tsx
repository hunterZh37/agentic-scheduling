"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { leadTimeFireAt, type LeadPreset } from "@/lib/nudge/leadTime";
import styles from "./ReminderControl.module.css";

interface ItemRef {
  kind: "event" | "booking" | "todo" | "followup";
  id: string;
  account?: string;
}

interface ReminderControlProps {
  title: string;
  startISO?: string | null;
  itemRef: ItemRef;
  /// Show this item's set reminders as an inline list next to the bell (used in
  /// the event modal). Compact rows (todos/follow-ups) leave it off.
  inlineList?: boolean;
  /// One-line mode (Blocks agenda): bell + each reminder's time inline on a
  /// single row, no "Reminders" label. Empty state is just the bell.
  compact?: boolean;
}

interface ReminderRow {
  id: string;
  whenLabel: string;
  body: string;
  recurring: boolean;
  eventKind: string | null;
  eventId: string | null;
}

const PRESETS: Array<{ key: Exclude<LeadPreset, "custom">; label: string }> = [
  { key: "at", label: "At start" },
  { key: "m10", label: "10 min before" },
  { key: "h1", label: "1 hr before" },
  { key: "d1", label: "1 day before" },
];

/// A preset is "past" when its computed fire time is already ≤ now — e.g. every
/// preset of an event that has already started. Such presets are disabled so the
/// user never picks one that the server would reject with fire_time_in_past.
function presetIsPast(startISO: string | null | undefined, preset: Exclude<LeadPreset, "custom">, nowMs: number): boolean {
  if (!startISO) return false;
  const iso = leadTimeFireAt(startISO, preset);
  return iso == null || new Date(iso).getTime() <= nowMs;
}

/// The first still-valid preset (in display order), or "custom" if the start is
/// unknown or every preset is already past (e.g. an in-progress event).
function firstValidPreset(startISO: string | null | undefined): LeadPreset {
  if (!startISO) return "custom";
  const now = Date.now();
  const valid = PRESETS.find((p) => !presetIsPast(startISO, p.key, now));
  return valid ? valid.key : "custom";
}

/// A `datetime-local` input's value is local wall-clock with no zone info —
/// the browser interprets it in the viewer's own zone, which is what we want.
function customLocalToISO(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/// Bell button + small anchored popover for setting a one-off reminder on an
/// event/booking/todo/followup. Fills in when the item already has ≥1
/// reminder (matched by eventKind/eventId).
export default function ReminderControl({ title, startISO, itemRef, inlineList, compact }: ReminderControlProps) {
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<ReminderRow[]>([]);
  const [preset, setPreset] = useState<LeadPreset>(() => firstValidPreset(startISO));
  // Captured when the popover opens (not read during render — impure) so preset
  // "past" checks use a fresh clock without re-running every render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [customLocal, setCustomLocal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const customFieldId = useId();

  // The concrete instant the current choice resolves to. Shown back to the
  // reader before they commit: "At start" or "1 hr before" says nothing about
  // WHEN a reminder actually arrives, which was the main thing that made this
  // panel hard to read.
  const previewISO = leadTimeFireAt(startISO ?? null, preset, customLocalToISO(customLocal));
  const previewLabel = previewISO
    ? DateTime.fromISO(previewISO).setZone(OWNER_TIMEZONE).toFormat("EEE, MMM d 'at' h:mm a")
    : null;
  // Compared against the clock captured when the panel opened, not a fresh
  // Date.now() read during render (which would make render impure).
  const previewIsPast = previewISO ? new Date(previewISO).getTime() <= nowMs : false;

  // What the reminder is attached to, for context in the panel header.
  const itemWhen = startISO
    ? DateTime.fromISO(startISO).setZone(OWNER_TIMEZONE).toFormat("EEE, MMM d 'at' h:mm a")
    : null;

  // Only offer lead times that haven't already passed. A disabled chip with no
  // stated reason reads as a bug; an option that isn't there doesn't.
  const availablePresets = startISO ? PRESETS.filter((p) => !presetIsPast(startISO, p.key, nowMs)) : [];

  const load = () =>
    fetch("/api/reminders")
      .then((r) => r.json())
      .then((body) => {
        const all = (body.reminders ?? []) as ReminderRow[];
        setMine(all.filter((r) => r.eventKind === itemRef.kind && r.eventId === itemRef.id));
      })
      .catch(() => {}); // soft-fail: leave the bell inactive if the list can't load

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemRef.kind, itemRef.id]);

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);


  const remindMe = async () => {
    setError(null);
    const customISO = customLocalToISO(customLocal);
    const fireAtISO = leadTimeFireAt(startISO ?? null, preset, customISO);
    if (!fireAtISO) {
      setError("Pick a valid time.");
      return;
    }
    // For events/bookings, pass the event's day so the worker can re-read its
    // live details at fire time. Without eventDateISO the resolver bails and the
    // reminder sends only the static title. Todos/follow-ups are static (no ref day).
    const eventDateISO =
      (itemRef.kind === "event" || itemRef.kind === "booking") && startISO ? startISO : undefined;
    setBusy(true);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireAtISO, message: title, event: itemRef, eventDateISO }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setCustomLocal("");
        setPreset(firstValidPreset(startISO));
        await load();
      } else {
        setError(body.error ?? "Could not set reminder.");
      }
    } catch {
      setError("Could not set reminder.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
      if (res.ok) await load();
    } finally {
      setDeletingId(null);
    }
  };

  const active = mine.length > 0;
  // Don't show the same fire time twice — collapse reminders that render to the
  // same time label to a single chip (keeping the first).
  const shown = mine.filter(
    (r, i) => mine.findIndex((o) => o.whenLabel === r.whenLabel) === i
  );

  // Compact mode (Blocks agenda) is a pure indicator: render nothing when the
  // item has no reminder, so no bell shows unless one is actually set. (Adding
  // still happens from the event detail modal.) The parent row collapses via
  // `.reminderRow:empty`.
  if (compact && !active) return null;

  return (
    <div className={compact ? styles.wrapCompact : inlineList ? styles.wrapInline : styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={active ? `${styles.bell} ${styles.bellActive}` : styles.bell}
        onClick={() => {
          if (!open) {
            setNowMs(Date.now());
            setPreset(firstValidPreset(startISO));
          }
          setOpen((o) => !o);
        }}
        aria-pressed={active}
        aria-label={active ? "Reminders set" : "Set a reminder"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
      </button>
      {inlineList && <span className={styles.inlineLabel}>{active ? "Reminders" : "Add a reminder"}</span>}

      {/* Compact one-line mode: each reminder's time sits inline next to the bell. */}
      {compact &&
        shown.map((r) => (
          <span key={r.id} className={styles.compactChip}>
            <span className={styles.compactWhen}>{r.whenLabel}</span>
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={() => void remove(r.id)}
              disabled={deletingId === r.id}
              aria-label="Remove reminder"
            >
              ×
            </button>
          </span>
        ))}

      {inlineList && shown.length > 0 && (
        <ul className={styles.inlineList}>
          {shown.map((r) => (
            <li key={r.id} className={styles.inlineRow}>
              <span className={styles.inlineWhen}>{r.whenLabel}</span>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => void remove(r.id)}
                disabled={deletingId === r.id}
                aria-label="Remove reminder"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {open &&
        createPortal(
          <div className={styles.backdrop} onClick={() => setOpen(false)}>
            <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
          {/* Say what this reminder is for. The panel used to open on a bare
              row of lead-time chips with no mention of the item at all. */}
          <div className={styles.head}>
            <span className={styles.eyebrow}>Remind me about</span>
            <span className={styles.headTitle}>{title}</span>
            {itemWhen && <span className={styles.headWhen}>{itemWhen}</span>}
          </div>

          {availablePresets.length > 0 && (
            <div className={styles.presetsRow}>
              {availablePresets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={preset === p.key ? `${styles.presetChip} ${styles.presetChipActive}` : styles.presetChip}
                  onClick={() => setPreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <label className={styles.fieldLabel} htmlFor={customFieldId}>
            {availablePresets.length > 0 ? "Or pick an exact time" : "Pick a time"}
          </label>
          <input
            id={customFieldId}
            className={styles.customInput}
            type="datetime-local"
            value={customLocal}
            onFocus={() => setPreset("custom")}
            onChange={(e) => {
              setPreset("custom");
              setCustomLocal(e.target.value);
            }}
          />

          {/* Resolve the abstract choice into a real date and time. */}
          {previewLabel && (
            <p className={previewIsPast ? `${styles.preview} ${styles.previewPast}` : styles.preview}>
              {previewIsPast ? "That time has already passed" : <>Arrives <strong>{previewLabel}</strong></>}
            </p>
          )}

          <button
            type="button"
            className={styles.remindBtn}
            onClick={() => void remindMe()}
            disabled={busy || !previewISO || previewIsPast}
          >
            {busy ? "Setting…" : "Set reminder"}
          </button>
          {error && <p className={styles.error}>{error}</p>}

          {shown.length > 0 && (
            <ul className={styles.list}>
              <li className={styles.listHead}>
                {shown.length === 1 ? "1 reminder set" : `${shown.length} reminders set`}
              </li>
              {shown.map((r) => (
                <li key={r.id} className={styles.row}>
                  {/* Just the time. The message body is the item's own title,
                      which the panel header already states. */}
                  <span className={styles.rowLabel}>
                    <span className={styles.rowWhen}>{r.whenLabel}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={() => void remove(r.id)}
                    disabled={deletingId === r.id}
                    aria-label="Remove reminder"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
