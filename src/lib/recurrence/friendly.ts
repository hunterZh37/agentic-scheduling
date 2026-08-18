// Friendly recurrence <-> RRULE. The UI never shows a raw RRULE; it shows
// presets ("Every night", "Mon · Wed · Fri", "Weekdays", "Weekly") and a custom
// weekday chooser. These helpers convert both directions.

export const WEEKDAYS = [
  { code: "SU", short: "Sun", letter: "S" },
  { code: "MO", short: "Mon", letter: "M" },
  { code: "TU", short: "Tue", letter: "T" },
  { code: "WE", short: "Wed", letter: "W" },
  { code: "TH", short: "Thu", letter: "T" },
  { code: "FR", short: "Fri", letter: "F" },
  { code: "SA", short: "Sat", letter: "S" },
] as const;

export type WeekdayCode = (typeof WEEKDAYS)[number]["code"];

export type RecurrencePreset =
  | "never"
  | "everyday"
  | "everynight"
  | "weekdays"
  | "weekly"
  | "custom";

const WEEKDAY_ORDER: WeekdayCode[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAYS_SET = ["MO", "TU", "WE", "TH", "FR"];

export interface ParsedRule {
  freq?: "DAILY" | "WEEKLY";
  byday: WeekdayCode[];
}

export function parseRule(rule: string | null): ParsedRule {
  if (!rule) return { byday: [] };
  const parts = Object.fromEntries(
    rule
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((kv) => kv.split("="))
      .map(([k, v]) => [k.toUpperCase(), v?.toUpperCase()])
  );
  const freq = parts.FREQ as ParsedRule["freq"];
  const byday = (parts.BYDAY ? parts.BYDAY.split(",") : []) as WeekdayCode[];
  return { freq, byday };
}

function sortDays(days: WeekdayCode[]): WeekdayCode[] {
  return [...days].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
}

/// Human label for a block's recurrence. `isOvernight` distinguishes a nightly
/// block ("Every night") from a daytime daily one ("Every day").
export function friendlyRecurrence(rule: string | null, isOvernight = false): string {
  const { freq, byday } = parseRule(rule);
  if (!freq) return "Once";
  if (freq === "DAILY") return isOvernight ? "Every night" : "Every day";
  // WEEKLY
  if (byday.length === 0) return "Weekly";
  const set = new Set(byday);
  if (byday.length === 5 && WEEKDAYS_SET.every((d) => set.has(d as WeekdayCode))) return "Weekdays";
  if (byday.length === 2 && set.has("SA") && set.has("SU")) return "Weekends";
  return sortDays(byday)
    .map((code) => WEEKDAYS.find((w) => w.code === code)?.short ?? code)
    .filter(Boolean)
    .join(" · ");
}

/// Which preset a rule corresponds to (drives the picker's selected row).
export function detectPreset(rule: string | null, isOvernight = false): RecurrencePreset {
  const { freq, byday } = parseRule(rule);
  if (!freq) return "never";
  if (freq === "DAILY") return isOvernight ? "everynight" : "everyday";
  if (byday.length === 0) return "weekly";
  const set = new Set(byday);
  if (byday.length === 5 && WEEKDAYS_SET.every((d) => set.has(d as WeekdayCode))) return "weekdays";
  return "custom";
}

/// Build an RRULE body from a preset (or explicit custom weekdays).
export function presetToRule(
  preset: RecurrencePreset,
  customDays: WeekdayCode[] = []
): string | null {
  switch (preset) {
    case "never":
      return null;
    case "everyday":
    case "everynight":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly":
      return "FREQ=WEEKLY";
    case "custom":
      return customDays.length ? `FREQ=WEEKLY;BYDAY=${sortDays(customDays).join(",")}` : null;
  }
}

// --- UNTIL -----------------------------------------------------------------
// A repeating block that also has an end DATE encodes that end as the rule's
// UNTIL, not as a longer span. Storing it as a span instead makes each
// occurrence as long as the whole range, and once the span exceeds the
// recurrence interval the occurrences overlap into permanent busy time.

const UNTIL_RE = /(?:^|;)UNTIL=[^;]*/gi;

/// Drop any UNTIL part, returning the bare rule body.
export function stripUntil(rule: string): string {
  return rule.replace(UNTIL_RE, "").replace(/^;+/, "").replace(/;;+/g, ";");
}

/// The instant a rule stops repeating, or null if it repeats forever.
export function ruleUntil(rule: string | null): Date | null {
  if (!rule) return null;
  const m = /(?:^|;)UNTIL=(\d{8}T\d{6}Z)/i.exec(rule);
  if (!m) return null;
  const v = m[1];
  const d = new Date(
    `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`
  );
  return isNaN(d.getTime()) ? null : d;
}

/// Set (or replace) the UNTIL on a rule body. `until` is a UTC instant.
export function withUntil(rule: string, until: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${until.getUTCFullYear()}${p(until.getUTCMonth() + 1)}${p(until.getUTCDate())}` +
    `T${p(until.getUTCHours())}${p(until.getUTCMinutes())}${p(until.getUTCSeconds())}Z`;
  return `${stripUntil(rule)};UNTIL=${stamp}`;
}
