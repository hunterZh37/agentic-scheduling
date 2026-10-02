import { DateTime } from "luxon";
import { expandBlock } from "@/lib/availability/recurrence";
import type { AgendaItem } from "./detailItem";
import type { BlockRow } from "./BlocksPane";

/// The Timeline view's block rows for one day (owner, 2026-10-02): every
/// reserved block that occurs on `day`, as lean agenda rows clipped to the day.
/// Every block is included, eye on or off: the eye governs the calendar grid,
/// and a day's timeline should show the day's real shape. An overnight block
/// yields two rows (last night's tail, tonight's start). Uses the same
/// expansion as the availability engine, so what the timeline shows is what
/// the booking page treats as busy.
export function dayBlockItems(blocks: BlockRow[], day: DateTime): AgendaItem[] {
  const dayStart = day.startOf("day");
  const dayEnd = day.endOf("day");
  const out: AgendaItem[] = [];
  for (const b of blocks) {
    const parts = expandBlock(
      {
        startTime: new Date(b.startTime),
        endTime: new Date(b.endTime),
        timezone: b.timezone,
        recurrenceRule: b.recurrenceRule,
      },
      dayStart.toUTC().toJSDate(),
      dayEnd.toUTC().toJSDate()
    );
    for (const p of parts) {
      out.push({
        key: `block:${b.id}:${p.start.toISOString()}`,
        kind: "block",
        title: b.title,
        start: p.start.toISOString(),
        end: p.end.toISOString(),
        allDay: false,
        colorVar: "--state-busy",
        blockId: b.id,
        // Crossing off is per occurrence (the agenda's check-off store), never
        // the block record's series-wide `done`.
      });
    }
  }
  return out;
}

/// The day's agenda plus its block rows, in clock order, all-day items last,
/// the same order Sections uses, so toggling the view never reorders the rest.
export function mergeTimeline(agenda: AgendaItem[], blockItems: AgendaItem[]): AgendaItem[] {
  return [...agenda, ...blockItems].sort(
    (a, b) => Number(a.allDay) - Number(b.allDay) || a.start.localeCompare(b.start)
  );
}
