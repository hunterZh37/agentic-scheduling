"use client";

import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import styles from "./BirthdaysManager.module.css";

interface BirthdayRow {
  id: string;
  name: string;
  month: number;
  day: number;
  year: number | null;
}

/// The age a birthday's person turns at their NEXT upcoming occurrence — the
/// same "occurrence year minus birth year" the server uses for the day-agenda
/// and month-chip views (see birthdayOccurrencesInRange). Null with no
/// recorded birth year.
function upcomingAge(b: BirthdayRow, now: DateTime): number | null {
  if (b.year == null) return null;
  const day = b.month === 2 && b.day === 29 ? 28 : b.day; // clamp leap-day in non-leap years
  let next = DateTime.fromObject({ year: now.year, month: b.month, day }, { zone: now.zone }).startOf("day");
  if (next < now.startOf("day")) next = next.plus({ years: 1 });
  return next.year - b.year;
}

/// "Mon D" label for a month/day pair. Anchored to a fixed leap year so a
/// Feb 29 birthday still formats regardless of the current year.
function monthDayLabel(month: number, day: number): string {
  return DateTime.fromObject({ year: 2024, month, day }).toFormat("LLL d");
}

/// Modal to add/remove birthdays (recurring month/day + optional birth year).
/// Mirrors CalendarsManager's overlay/sheet shell.
export function BirthdaysManager({ onClose }: { onClose: () => void }) {
  const [birthdays, setBirthdays] = useState<BirthdayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [year, setYear] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = () =>
    fetch("/api/birthdays")
      .then((r) => r.json())
      .then((d) => setBirthdays((d.birthdays ?? []) as BirthdayRow[]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const canAdd = name.trim().length > 0 && month.trim() !== "" && day.trim() !== "" && !saving;

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/birthdays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          month: Number(month),
          day: Number(day),
          ...(year.trim() !== "" ? { year: Number(year) } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setName("");
        setMonth("");
        setDay("");
        setYear("");
        await reload();
      } else {
        setError(body.error ?? "Could not add birthday.");
      }
    } catch {
      setError("Could not add birthday.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/birthdays/${id}`, { method: "DELETE" });
      if (res.ok) setBirthdays((rows) => rows.filter((b) => b.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  const now = DateTime.now().setZone(OWNER_TIMEZONE);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        <div className={styles.header}>
          <h3 className={styles.title}>
            Birthdays <span className={styles.count}>{birthdays.length}</span>
          </h3>
        </div>

        <div className={styles.addCard}>
          <input
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
          />
          <div className={styles.dateRow}>
            <input
              className={styles.numInput}
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              placeholder="MM"
              aria-label="Birth month"
              onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
            />
            <span className={styles.dateSep}>/</span>
            <input
              className={styles.numInput}
              type="number"
              min={1}
              max={31}
              value={day}
              onChange={(e) => setDay(e.target.value)}
              placeholder="DD"
              aria-label="Birth day"
              onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
            />
            <input
              className={styles.yearInput}
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="Year (optional)"
              aria-label="Birth year"
              onKeyDown={(e) => e.key === "Enter" && canAdd && void add()}
            />
          </div>
          <button className={styles.addBtn} onClick={() => void add()} disabled={!canAdd}>
            {saving ? "Adding…" : "Add birthday"}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </div>

        {loading ? (
          <p className={styles.empty}>Loading…</p>
        ) : birthdays.length === 0 ? (
          <p className={styles.empty}>No birthdays yet.</p>
        ) : (
          <ul className={styles.list}>
            {birthdays.map((b) => {
              const age = upcomingAge(b, now);
              return (
                <li key={b.id} className={styles.row}>
                  <span className={styles.rowLabel}>
                    🎂 {monthDayLabel(b.month, b.day)} — {b.name}
                    {age != null && <span className={styles.age}> (turns {age})</span>}
                  </span>
                  <button
                    className={styles.deleteBtn}
                    onClick={() => void remove(b.id)}
                    disabled={deletingId === b.id}
                    aria-label={`Delete ${b.name}'s birthday`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
