import { DateTime } from "luxon";

export interface ResolvedEvent {
  title: string;
  start: Date;
}

/// Fresh line when the linked event resolved at fire time; otherwise the stored
/// snapshot body verbatim.
export function renderNudge(nudge: { body: string }, resolved: ResolvedEvent | null, tz: string): string {
  if (!resolved) return nudge.body;
  const when = DateTime.fromJSDate(resolved.start, { zone: "utc" }).setZone(tz).toFormat("h:mm a");
  return `⏰ ${resolved.title} at ${when} — ${nudge.body}`;
}
