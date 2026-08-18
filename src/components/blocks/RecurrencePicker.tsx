"use client";

import { useState } from "react";
import {
  RecurrencePreset,
  WeekdayCode,
  WEEKDAYS,
  presetToRule,
} from "@/lib/recurrence/friendly";
import styles from "./RecurrencePicker.module.css";

export interface RecurrenceValue {
  preset: RecurrencePreset;
  customDays: WeekdayCode[];
}

const PRESETS: Array<{ preset: RecurrencePreset; label: string }> = [
  { preset: "never", label: "Never" },
  { preset: "everyday", label: "Every Day" },
  { preset: "everynight", label: "Every Night" },
  { preset: "weekdays", label: "Weekdays" },
  { preset: "weekly", label: "Weekly" },
];

/// Presets + a custom weekday chooser. Emits both the friendly value and the
/// resulting RRULE body so the caller can persist it.
export function RecurrencePicker({
  value,
  onChange,
}: {
  value: RecurrenceValue;
  onChange: (value: RecurrenceValue, rule: string | null) => void;
}) {
  const [custom, setCustom] = useState(value.preset === "custom");

  const choosePreset = (preset: RecurrencePreset) => {
    setCustom(false);
    onChange({ preset, customDays: value.customDays }, presetToRule(preset, value.customDays));
  };

  const toggleDay = (code: WeekdayCode) => {
    const has = value.customDays.includes(code);
    const nextDays = has
      ? value.customDays.filter((d) => d !== code)
      : [...value.customDays, code];
    onChange({ preset: "custom", customDays: nextDays }, presetToRule("custom", nextDays));
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>REPEAT</div>
      <div className={styles.list}>
        {PRESETS.map((p) => {
          const selected = !custom && value.preset === p.preset;
          return (
            <button
              key={p.preset}
              className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
              onClick={() => choosePreset(p.preset)}
            >
              <span>{p.label}</span>
              {selected && <span className={styles.check}>✓</span>}
            </button>
          );
        })}
        <button
          className={`${styles.row} ${styles.customRow} ${custom ? styles.customActive : ""}`}
          onClick={() => {
            setCustom(true);
            onChange({ preset: "custom", customDays: value.customDays }, presetToRule("custom", value.customDays));
          }}
        >
          <span>Custom…</span>
          <span className={styles.chevron}>›</span>
        </button>
      </div>

      {custom && (
        <div className={styles.days}>
          {WEEKDAYS.map((w, i) => {
            const on = value.customDays.includes(w.code);
            return (
              <button
                key={`${w.code}-${i}`}
                className={`${styles.day} ${on ? styles.dayOn : ""}`}
                onClick={() => toggleDay(w.code)}
                aria-pressed={on}
                aria-label={w.short}
              >
                {w.letter}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
