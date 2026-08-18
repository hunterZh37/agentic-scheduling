"use client";

// Fire a haptic on a meaningful commit — a booking confirmed, a block toggled,
// a sheet snapping home. Reserve it for moments that matter; buzzing on every
// tap trains people to ignore it (Apple's "utility" rule for feedback).
//
// This uses the web Vibration API, which is supported on Android browsers and a
// no-op on iOS Safari (Apple exposes no web haptics). So it's a progressive
// enhancement: real feedback where the platform allows, silent everywhere else.
// Call it on the SAME frame as the visual change so sight and touch agree.

type HapticKind = "select" | "commit" | "success" | "warn";

// Short, distinct patterns (ms). Kept tiny — a tap, not a rumble.
const PATTERNS: Record<HapticKind, number | number[]> = {
  select: 8,
  commit: 12,
  success: [10, 40, 16],
  warn: [24, 30, 24],
};

export function haptic(kind: HapticKind = "select"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  // Don't buzz for users who asked the system to calm motion down.
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    /* vibrate can throw if called without a user gesture — ignore */
  }
}
