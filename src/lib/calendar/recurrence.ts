import { DateTime } from "luxon";

/// Microsoft Graph structured recurrence (a `recurrence` on an event). Graph
/// does NOT accept iCal RRULE strings — it wants a { pattern, range } object.
/// See https://learn.microsoft.com/graph/api/resources/patternedrecurrence
export interface GraphRecurrence {
  pattern: GraphPattern;
  range: GraphRange;
}
interface GraphPattern {
  type: "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly";
  interval: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  index?: "first" | "second" | "third" | "fourth" | "last";
  firstDayOfWeek?: string;
}
interface GraphRange {
  type: "noEnd" | "endDate" | "numbered";
  startDate: string; // YYYY-MM-DD, in recurrenceTimeZone
  endDate?: string; // YYYY-MM-DD
  numberOfOccurrences?: number;
  recurrenceTimeZone: string; // IANA, e.g. "America/Los_Angeles"
}

const RRULE_DAY_TO_GRAPH: Record<string, string> = {
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
  SU: "sunday",
};
const WEEKDAY_NUM_TO_GRAPH = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]; // luxon weekday: 1 = Monday … 7 = Sunday
const RRULE_INDEX_TO_GRAPH: Record<string, GraphPattern["index"]> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "-1": "last",
};

/// Parse an iCal RRULE body (no "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=SU")
/// into a map of its parts. Keys upper-cased; values left as-is.
function parseRule(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.trim().toUpperCase()] = v.trim();
  }
  return out;
}

/// Convert an iCal RRULE into Microsoft Graph's structured recurrence. `start`
/// is the first occurrence in the recurrence's own timezone (so its weekday /
/// day-of-month / month anchor the pattern when the rule doesn't name them).
/// Supports the rules this app emits: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL,
/// BYDAY (incl. an ordinal like 1SU → relativeMonthly), BYMONTHDAY, BYMONTH,
/// COUNT, and UNTIL. Throws on an unsupported FREQ.
export function rruleToGraphRecurrence(
  rrule: string,
  start: DateTime,
  timezone: string
): GraphRecurrence {
  const r = parseRule(rrule);
  const freq = (r.FREQ ?? "").toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL ?? "1", 10) || 1);

  let pattern: GraphPattern;
  if (freq === "DAILY") {
    pattern = { type: "daily", interval };
  } else if (freq === "WEEKLY") {
    const days = r.BYDAY
      ? r.BYDAY.split(",").map((d) => RRULE_DAY_TO_GRAPH[d.trim().toUpperCase()]).filter(Boolean)
      : [WEEKDAY_NUM_TO_GRAPH[start.weekday - 1]];
    pattern = { type: "weekly", interval, daysOfWeek: days, firstDayOfWeek: "sunday" };
  } else if (freq === "MONTHLY") {
    const byday = r.BYDAY?.trim();
    const ordinal = byday ? byday.match(/^(-?\d+)([A-Z]{2})$/i) : null;
    if (ordinal) {
      // e.g. BYDAY=1SU → the first Sunday of the month.
      pattern = {
        type: "relativeMonthly",
        interval,
        daysOfWeek: [RRULE_DAY_TO_GRAPH[ordinal[2].toUpperCase()]],
        index: RRULE_INDEX_TO_GRAPH[ordinal[1]] ?? "first",
      };
    } else {
      pattern = {
        type: "absoluteMonthly",
        interval,
        dayOfMonth: r.BYMONTHDAY ? parseInt(r.BYMONTHDAY, 10) : start.day,
      };
    }
  } else if (freq === "YEARLY") {
    pattern = {
      type: "absoluteYearly",
      interval,
      month: r.BYMONTH ? parseInt(r.BYMONTH, 10) : start.month,
      dayOfMonth: r.BYMONTHDAY ? parseInt(r.BYMONTHDAY, 10) : start.day,
    };
  } else {
    throw new Error(`Unsupported RRULE FREQ: ${freq || "(none)"}`);
  }

  const startDate = start.toFormat("yyyy-MM-dd");
  let range: GraphRange;
  if (r.COUNT) {
    range = {
      type: "numbered",
      startDate,
      numberOfOccurrences: parseInt(r.COUNT, 10),
      recurrenceTimeZone: timezone,
    };
  } else if (r.UNTIL) {
    // UNTIL is a UTC-ish iCal timestamp (e.g. 20261231T235959Z or 20261231);
    // Graph wants a plain end DATE in the recurrence timezone.
    const until = DateTime.fromFormat(r.UNTIL.replace(/Z$/i, ""), "yyyyMMdd'T'HHmmss", {
      zone: "utc",
    }).isValid
      ? DateTime.fromFormat(r.UNTIL.replace(/Z$/i, ""), "yyyyMMdd'T'HHmmss", { zone: "utc" })
      : DateTime.fromFormat(r.UNTIL, "yyyyMMdd", { zone: "utc" });
    range = {
      type: "endDate",
      startDate,
      endDate: until.setZone(timezone).toFormat("yyyy-MM-dd"),
      recurrenceTimeZone: timezone,
    };
  } else {
    range = { type: "noEnd", startDate, recurrenceTimeZone: timezone };
  }

  return { pattern, range };
}
