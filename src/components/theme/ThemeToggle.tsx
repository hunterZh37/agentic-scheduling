"use client";

import { useTheme } from "./ThemeProvider";
import styles from "./ThemeToggle.module.css";

/// Compact light/dark toggle. Reflects the resolved theme; flips manual override.
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      className={styles.toggle}
      onClick={toggle}
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
    >
      {resolved === "dark" ? "☾" : "☀"}
    </button>
  );
}
