"use client";

import { useState } from "react";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { RecurrencePicker, type RecurrenceValue } from "./RecurrencePicker";
import { presetToRule, detectPreset, parseRule, ruleUntil, withUntil, stripUntil } from "@/lib/recurrence/friendly";
import styles from "./NewBlockSheet.module.css";

/// The block fields the sheet needs to pre-fill an edit. A subset of BlockRow.
export interface EditableBlock {
  id: string;
  title: string;
  startTime: string; // UTC ISO
  endTime: string; // UTC ISO
  timezone: string;
  recurrenceRule: string | null;
}

/// Create OR edit a reserved block. Pass `block` to edit an existing one
/// (pre-fills the fields and PATCHes on save); omit it to create a new one.
export function NewBlockSheet({
  block,
  onClose,
  onCreated,
}: {
  block?: EditableBlock;
  onClose: () => void;
  onCreated: () => void;
}) {
  const editing = block != null;
  // The zone a block is authored in stays fixed across an edit; new blocks use
  // the owner's zone. Times below are the wall-clock in this zone.
  const zone = block?.timezone ?? OWNER_TIMEZONE;
  const startLocal = block ? DateTime.fromISO(block.startTime, { zone: "utc" }).setZone(zone) : null;
  const endLocal = block ? DateTime.fromISO(block.endTime, { zone: "utc" }).setZone(zone) : null;
  const overnight = !!(startLocal && endLocal && endLocal.toFormat("HH:mm") <= startLocal.toFormat("HH:mm"));

  // All-day blocks are stored as [startDate 00:00, (endDate + 1 day) 00:00) so
  // they cover the end day in full. Detect that shape on edit so the toggle and
  // the shown end date round-trip (the stored end lands on the day AFTER the last
  // covered day).
  const startedAllDay = !!(
    startLocal &&
    endLocal &&
    startLocal.toFormat("HH:mm") === "00:00" &&
    endLocal.toFormat("HH:mm") === "00:00" &&
    endLocal > startLocal
  );
  const today = DateTime.now().setZone(zone).startOf("day");

  const [title, setTitle] = useState(block?.title ?? "");
  const [allDay, setAllDay] = useState(startedAllDay);
  const [startDate, setStartDate] = useState((startLocal ?? today).toISODate()!);
  // A repeating block carries its last day as the rule's UNTIL, so read the end
  // date back from there; only a non-repeating span keeps it in endTime.
  const untilLocal = block ? ruleUntil(block.recurrenceRule) : null;
  const [endDate, setEndDate] = useState(
    (untilLocal
      ? DateTime.fromJSDate(untilLocal).setZone(zone)
      : startedAllDay
        ? endLocal!.minus({ days: 1 })
        : (endLocal ?? startLocal ?? today)
    ).toISODate()!
  );
  const [startTime, setStartTime] = useState(startLocal ? startLocal.toFormat("HH:mm") : "09:00");
  const [endTime, setEndTime] = useState(endLocal ? endLocal.toFormat("HH:mm") : "10:00");
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(() =>
    block
      ? { preset: detectPreset(block.recurrenceRule, overnight), customDays: parseRule(block.recurrenceRule).byday }
      : { preset: "never", customDays: [] }
  );
  const [rule, setRule] = useState<string | null>(block?.recurrenceRule ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the end on/after the start as the user picks dates, so the range never
  // silently inverts (which the server would reject as invalid_range).
  const changeStartDate = (value: string) => {
    setStartDate(value);
    if (value > endDate) setEndDate(value);
  };

  const canSave = title.trim().length > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // The block runs from startDate to endDate. All-day covers each day in
      // full: [startDate 00:00, endDate + 1 day 00:00). Timed uses the time
      // pickers; a same-day range whose end time is <= its start time rolls the
      // end to the next day (the overnight case, e.g. Sleep 23:00–07:00).
      const baseRule = rule ?? presetToRule(recurrence.preset, recurrence.customDays);
      const repeats = !!baseRule;

      // A REPEATING block describes ONE occurrence; the date range says how long
      // to keep repeating it (the rule's UNTIL). Measuring the occurrence across
      // the whole range instead makes every occurrence as long as the range, and
      // once that exceeds the recurrence interval the occurrences overlap into
      // unbroken busy time - "7-9am daily, Aug 5-26" became a 21-day block
      // restarting every day, which left no bookable minute anywhere.
      // A NON-repeating block is the opposite: the range IS the block (a weekend
      // hold), so it keeps spanning start date to end date.
      const lastDay = repeats ? startDate : endDate;
      let start: DateTime;
      let end: DateTime;
      if (allDay) {
        start = DateTime.fromISO(startDate, { zone }).startOf("day");
        end = DateTime.fromISO(lastDay, { zone }).startOf("day").plus({ days: 1 });
      } else {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        start = DateTime.fromISO(startDate, { zone }).set({ hour: sh, minute: sm });
        end = DateTime.fromISO(lastDay, { zone }).set({ hour: eh, minute: em });
        if (lastDay === startDate && end <= start) end = end.plus({ days: 1 }); // overnight
      }
      if (end <= start) {
        setError("End must be after start.");
        setSaving(false);
        return;
      }

      const payload = {
        title: title.trim(),
        startTime: start.toUTC().toISO(),
        endTime: end.toUTC().toISO(),
        timezone: zone,
        recurrenceRule: !baseRule
          ? null
          : endDate > startDate
            ? withUntil(baseRule, DateTime.fromISO(endDate, { zone }).endOf("day").toUTC().toJSDate())
            : stripUntil(baseRule),
      };
      const res = await fetch(editing ? `/api/blocks/${block!.id}` : "/api/blocks", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Could not ${editing ? "save" : "create"} block.`);
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{editing ? "Edit block" : "New block"}</h3>

        <label className={styles.label}>Title</label>
        <input
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Sleep, Gym, Vacation…"
          autoFocus
        />

        <div className={styles.timeRow}>
          <div className={styles.timeField}>
            <label className={styles.label}>Start date</label>
            <input
              className={styles.input}
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => changeStartDate(e.target.value)}
            />
          </div>
          <div className={styles.timeField}>
            <label className={styles.label}>End date</label>
            <input
              className={styles.input}
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <label className={styles.checkRow}>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>All day</span>
        </label>

        {!allDay && (
          <div className={styles.timeRow}>
            <div className={styles.timeField}>
              <label className={styles.label}>Start time</label>
              <input
                className={styles.input}
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className={styles.timeField}>
              <label className={styles.label}>End time</label>
              <input
                className={styles.input}
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className={styles.picker}>
          <RecurrencePicker
            value={recurrence}
            onChange={(v, r) => {
              setRecurrence(v);
              setRule(r);
            }}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button className={styles.cancel} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className={styles.confirm} onClick={save} disabled={!canSave}>
            {saving ? (editing ? "Saving…" : "Adding…") : editing ? "Save changes" : "Add block"}
          </button>
        </div>
      </div>
    </div>
  );
}
