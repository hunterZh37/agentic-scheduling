"use client";

import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import styles from "@/components/calendar/EventModal.module.css";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { detectPreset, presetToRule, type RecurrencePreset } from "@/lib/recurrence/friendly";
import type { RecurringRow } from "./BlocksPane";

// Detail / edit panel for a recurring SCHEDULE (a RecurringTodo). Opens the same
// way as the actionable/event detail modal (click the row title), reusing
// EventModal's shell so it looks identical. Lets the owner rename it, change the
// cadence, set/clear a time-of-day, see the next trigger (day + time), jump to
// that day on the calendar, and stop the series.

// The presets a recurring schedule can hold (it always repeats — "never" is not
// an option here; use Stop to end it).
const PRESETS: Array<{ value: RecurrencePreset; label: string }> = [
  { value: "everyday", label: "Every day" },
  { value: "weekly", label: "Weekly" },
  { value: "weekdays", label: "Weekdays" },
  { value: "monthly", label: "Every month" },
  { value: "monthlyLast", label: "Monthly on the last day" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const minutesToHM = (m: number | null): string => (m == null ? "" : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);

export function RecurringModal({
  row,
  onClose,
  onSaved,
  onStop,
  onGoToDay,
}: {
  row: RecurringRow;
  onClose: () => void;
  /// Called after a successful save so the parent can reload the pane.
  onSaved: () => void;
  /// Stop the series — parent opens the same confirm dialog the row's ✕ uses.
  onStop: (row: RecurringRow) => void;
  /// Jump the agenda to a given owner-local day (ISO date), so the next
  /// occurrence can be seen on the calendar.
  onGoToDay: (isoDate: string) => void;
}) {
  const initialPreset = useMemo<RecurrencePreset>(() => {
    const p = detectPreset(row.rrule);
    return PRESETS.some((x) => x.value === p) ? p : "monthly";
  }, [row.rrule]);

  const [title, setTitle] = useState(row.title);
  const [preset, setPreset] = useState<RecurrencePreset>(initialPreset);
  const [start, setStart] = useState(minutesToHM(row.startMinutes));
  const [end, setEnd] = useState(minutesToHM(row.endMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The next trigger, shown live from the CURRENT draft time so editing the time
  // updates it immediately.
  const nextLine = useMemo(() => {
    if (!row.nextOccurrence) return "No more occurrences";
    const day = DateTime.fromISO(row.nextOccurrence, { zone: OWNER_TIMEZONE }).startOf("day");
    const today = DateTime.now().setZone(OWNER_TIMEZONE).startOf("day");
    const dayLabel = day.equals(today) ? "today" : day.equals(today.plus({ days: 1 })) ? "tomorrow" : day.toFormat("EEE, MMM d");
    if (start && end) {
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      const s = day.set({ hour: sh, minute: sm });
      const e = day.set({ hour: eh, minute: em });
      return `${dayLabel}, ${s.toFormat("h:mm")}–${e.toFormat("h:mm a")}`;
    }
    return `${dayLabel} (all day)`;
  }, [row.nextOccurrence, start, end]);

  const save = async () => {
    const t = title.trim();
    if (!t) {
      setError("A title is required.");
      return;
    }
    // Time is optional; if given, both ends are required and end must be after
    // start. Build representative ISO instants (the API reads their owner-local
    // time-of-day). An empty pair clears the time.
    const wantsStart = start !== "";
    const wantsEnd = end !== "";
    if (wantsStart !== wantsEnd) {
      setError("Set both a start and end time, or clear both.");
      return;
    }
    const day = DateTime.now().setZone(OWNER_TIMEZONE);
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (wantsStart && wantsEnd) {
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      const s = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      const e = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
      if (e <= s) {
        setError("End time must be after start time.");
        return;
      }
      startTime = s.toUTC().toISO();
      endTime = e.toUTC().toISO();
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recurring/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, rrule: presetToRule(preset), startTime, endTime }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message ?? "Could not save.");
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Recurring schedule">
        <div className={styles.head}>
          <h2 className={styles.title}>Recurring schedule</h2>
          <div className={styles.headActions}>
            <button className={styles.close} onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        <label className={styles.fLabel}>Title</label>
        <input className={styles.fInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What repeats" />

        <div className={styles.fGrid}>
          <div className={styles.fCol}>
            <label className={styles.fLabel}>Repeat</label>
            <select className={styles.fInput} value={preset} onChange={(e) => setPreset(e.target.value as RecurrencePreset)}>
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.fCol}>
            <label className={styles.fLabel}>Start time</label>
            <input className={styles.fInput} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className={styles.fCol}>
            <label className={styles.fLabel}>End time</label>
            <input className={styles.fInput} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <p className={styles.hint}>
          Leave the times empty for an all-day checklist item. Setting a time places each occurrence on your calendar at
          that time.
        </p>

        <div className={styles.nextTrigger}>
          <span className={styles.fLabel}>Next trigger</span>
          <div className={styles.nextTriggerRow}>
            <span className="tnum">{nextLine}</span>
            {row.nextOccurrence && (
              <button
                className={styles.btnGhost}
                type="button"
                onClick={() => {
                  onGoToDay(row.nextOccurrence!);
                  onClose();
                }}
              >
                Go to that day
              </button>
            )}
          </div>
        </div>

        {error && <p className={styles.fError}>{error}</p>}

        <div className={styles.footerEdit}>
          <button className={styles.btnDanger} onClick={() => onStop(row)} disabled={busy}>
            Stop
          </button>
          <span className={styles.footerSpacer} />
          <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className={styles.btnPrimary} onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
