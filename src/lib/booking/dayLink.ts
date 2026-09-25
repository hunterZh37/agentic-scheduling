import { DateTime } from "luxon";

/// Deep link to one day on the booking page: `/book?date=YYYY-MM-DD`, plus
/// `duration=` when the open panel is showing a non-default length. Written
/// to the address bar while a day's times panel is open, so the owner can
/// copy the URL and send "the link to this specific day"; read on load to
/// open that panel. The day is a calendar date in the BOOKER's zone.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/// The day a `date` param names, at local midnight in `zone`, or null when
/// it is missing, malformed, invalid, or already past (a link to yesterday
/// just opens the page normally).
export function parseDayParam(
  raw: string | undefined | null,
  zone: string,
  today: DateTime = DateTime.now().setZone(zone).startOf("day")
): DateTime | null {
  if (!raw || !DAY_RE.test(raw)) return null;
  const d = DateTime.fromISO(raw, { zone }).startOf("day");
  if (!d.isValid) return null;
  if (d < today.setZone(zone).startOf("day")) return null;
  return d;
}

/// The search string for the current panel state: `open` = the day being
/// shown and the length in use; null = no panel open. Unrelated params
/// (preview, reschedule tokens) are preserved untouched.
export function dayLinkSearch(
  current: URLSearchParams,
  open: { day: string; duration: number; defaultDuration: number } | null
): string {
  const next = new URLSearchParams(current);
  next.delete("date");
  next.delete("duration");
  if (open) {
    next.set("date", open.day);
    if (open.duration !== open.defaultDuration) next.set("duration", String(open.duration));
  }
  const s = next.toString();
  return s ? `?${s}` : "";
}
