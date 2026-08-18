import { DateTime } from "luxon";

export interface BirthdayInput {
  name: string;
  month: number;
  day: number;
  year?: number;
}
export type ParseResult = { ok: true; value: BirthdayInput } | { ok: false; error: string };

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29 (leap-day birthdays)

/// Validate a raw birthday payload. Year, if present, must be 1900..current year.
export function parseBirthdayInput(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return { ok: false, error: "invalid_name" };

  const month = Number(r.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: "invalid_month" };

  const day = Number(r.day);
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) return { ok: false, error: "invalid_day" };

  let year: number | undefined;
  if (r.year !== undefined && r.year !== null && r.year !== "") {
    year = Number(r.year);
    const current = DateTime.utc().year;
    if (!Number.isInteger(year) || year < 1900 || year > current) return { ok: false, error: "invalid_year" };
  }

  return { ok: true, value: { name, month, day, ...(year !== undefined ? { year } : {}) } };
}

export interface BirthdayRecord {
  id: string;
  name: string;
  month: number;
  day: number;
  year: number | null;
}
export interface BirthdayOccurrence {
  id: string;
  name: string;
  date: Date; // local-midnight instant of the occurrence in `tz`
  age: number | null;
}

/// Every occurrence whose local calendar date (in `tz`) falls within [start, end).
export function birthdayOccurrencesInRange(
  birthdays: BirthdayRecord[],
  start: Date,
  end: Date,
  tz: string
): BirthdayOccurrence[] {
  const startLocal = DateTime.fromJSDate(start, { zone: "utc" }).setZone(tz);
  const endLocal = DateTime.fromJSDate(end, { zone: "utc" }).setZone(tz);
  const out: BirthdayOccurrence[] = [];
  // Candidate years the window could touch (inclusive).
  for (let year = startLocal.year; year <= endLocal.year; year++) {
    for (const b of birthdays) {
      // Leap-day birthdays fall back to Feb 28 in non-leap years so they're
      // never missed on the calendar/agenda/brief (mirrors sortBirthdaysUpcoming).
      const day =
        b.month === 2 && b.day === 29 && !DateTime.fromObject({ year, month: 2, day: 29 }).isValid
          ? 28
          : b.day;
      const occ = DateTime.fromObject({ year, month: b.month, day }, { zone: tz }).startOf("day");
      if (!occ.isValid) continue;
      const jd = occ.toJSDate();
      if (jd >= start && jd < end) {
        out.push({ id: b.id, name: b.name, date: jd, age: b.year != null ? year - b.year : null });
      }
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/// Sort by days until the next occurrence from `today` (wrapping the year).
export function sortBirthdaysUpcoming(birthdays: BirthdayRecord[], today: Date, tz: string): BirthdayRecord[] {
  const now = DateTime.fromJSDate(today, { zone: "utc" }).setZone(tz).startOf("day");
  const daysUntil = (b: BirthdayRecord): number => {
    // Next occurrence on/after today. Clamp Feb 29 to Feb 28 for the distance calc.
    const day = b.month === 2 && b.day === 29 ? 28 : b.day;
    let next = DateTime.fromObject({ year: now.year, month: b.month, day }, { zone: tz }).startOf("day");
    if (next < now) next = next.plus({ years: 1 });
    return Math.round(next.diff(now, "days").days);
  };
  return [...birthdays].sort((a, b) => daysUntil(a) - daysUntil(b));
}
