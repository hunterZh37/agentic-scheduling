// Pure helpers for ending a recurring series. The I/O lives in write.ts.

/// `20261018T235959Z`: the UNTIL form iCal wants for a timed series.
export function untilStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/// A Google `recurrence` array with its RRULE ended at `at`. Any existing
/// UNTIL or COUNT is replaced; EXDATE and RDATE lines are kept, so days the
/// owner already skipped stay skipped. A series with no RRULE is returned
/// unchanged.
export function endRecurrenceAt(recurrence: string[], at: Date): string[] {
  return recurrence.map((line) => {
    if (!/^RRULE:/i.test(line)) return line;
    const parts = line
      .slice("RRULE:".length)
      .split(";")
      .filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p));
    return `RRULE:${[...parts, `UNTIL=${untilStamp(at)}`].join(";")}`;
  });
}

/// `2026-10-18` in the given zone, for Microsoft Graph's range.endDate.
export function endDateIn(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
