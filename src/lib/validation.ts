import { DateTime } from "luxon";

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/// Parse start/end query params from a request URL. Returns an error string or
/// the parsed range.
export function parseRange(
  url: URL
): { start: Date; end: Date } | { error: string } {
  const start = parseIsoDate(url.searchParams.get("start"));
  const end = parseIsoDate(url.searchParams.get("end"));
  if (!start || !end) return { error: "start and end (ISO 8601) are required." };
  if (end <= start) return { error: "end must be after start." };
  return { start, end };
}

/// Bounds for a requested meeting duration. A slot shorter than MIN is
/// meaningless, and fractional values used to slip through: `duration=0.5`
/// produced 960 zero-length "slots" for a single day (~57,600 across the
/// booking horizon), which is both nonsense to book and an unauthenticated
/// response-size amplifier.
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 1440; // 24h

/// Parse a caller-supplied duration in minutes. Returns null when absent (use
/// the configured default) or an error string when present but unusable.
/// Requires a whole number within [MIN, MAX] — not merely "finite and > 0".
export function parseDurationMinutes(
  value: unknown
): { minutes: number | undefined } | { error: string } {
  if (value === undefined || value === null || value === "") return { minutes: undefined };
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: "duration must be a whole number of minutes." };
  }
  if (n < MIN_DURATION_MINUTES || n > MAX_DURATION_MINUTES) {
    return { error: `duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.` };
  }
  return { minutes: n };
}
