"use client";

import { useTheme } from "./ThemeProvider";
import styles from "./ThemeToggle.module.css";

/// Compact light/dark toggle. Reflects the resolved theme; flips manual override.
/// Inline SVGs, not the ☾ / ☀ glyphs: a text glyph sits on a baseline, so it
/// landed low and right of the circle's centre (optical audit, 2026-10-12).
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      className={styles.toggle}
      onClick={toggle}
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
    >
      {resolved === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
        </svg>
      )}
    </button>
  );
}
