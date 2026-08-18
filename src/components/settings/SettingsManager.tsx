"use client";

import { useEffect, useState } from "react";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import styles from "./SettingsManager.module.css";

interface Settings {
  bookingHorizonDays: number;
  minNoticeHours: number;
  bufferMinutes: number;
  defaultEventDurationMinutes: number;
}

const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: "minNoticeHours", label: "Minimum notice", hint: "Hours before a slot can be booked. 0 = no restriction." },
  { key: "bookingHorizonDays", label: "Booking window", hint: "How many days ahead people can book." },
  { key: "bufferMinutes", label: "Buffer between meetings", hint: "Minutes kept free around each booking." },
  { key: "defaultEventDurationMinutes", label: "Default meeting length", hint: "Minutes, when a length isn't chosen." },
];

/// Owner-only booking rules (minimum notice, window, buffer, default length).
/// Mirrors the other manager sheets.
export function SettingsManager({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "saved"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setSettings(d.settings as Settings))
      .catch(() => setStatus({ kind: "error", text: "Couldn't load settings." }));
  }, []);

  const setField = (key: keyof Settings, value: string) => {
    setSettings((s) => (s ? { ...s, [key]: value === "" ? 0 : Math.max(0, Math.round(Number(value) || 0)) } : s));
    setStatus(null);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setSettings(body.settings as Settings);
        setStatus({ kind: "saved", text: "Saved." });
      } else {
        setStatus({ kind: "error", text: `Couldn't save${body.field ? ` (${body.field})` : ""}.` });
      }
    } catch {
      setStatus({ kind: "error", text: "Couldn't save." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3 className={styles.title}>Booking settings</h3>
        <p className={styles.blurb}>How your public booking page and joint links offer time.</p>

        {!settings ? (
          <p className={styles.blurb}>Loading…</p>
        ) : (
          <>
            {FIELDS.map((f) => (
              <div key={f.key} className={styles.field}>
                <span className={styles.fieldText}>
                  <span className={styles.fieldLabel}>{f.label}</span>
                  <span className={styles.fieldHint}>{f.hint}</span>
                </span>
                <input
                  className={styles.num}
                  type="number"
                  min={0}
                  value={settings[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                  aria-label={f.label}
                />
              </div>
            ))}
            <div className={styles.saveRow}>
              <button className={styles.saveBtn} onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              {status && (
                <span className={`${styles.status} ${status.kind === "error" ? styles.error : styles.saved}`}>
                  {status.text}
                </span>
              )}
            </div>
          </>
        )}

        <p className={styles.tzNote}>
          Times are shown in <strong>{OWNER_TIMEZONE.replace(/_/g, " ")}</strong> on your dashboard, and
          in each visitor&apos;s own zone on the booking page. Changing your time zone is a separate step
          for now: ask and I&apos;ll switch it.
        </p>
      </div>
    </div>
  );
}
