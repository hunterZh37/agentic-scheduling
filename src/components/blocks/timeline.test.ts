import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { dayBlockItems, mergeTimeline } from "./timeline";
import type { AgendaItem } from "./detailItem";

// The Timeline view (owner, 2026-10-02): one time-ordered list for the day
// where reserved blocks sit between the day's events and actionables, so the
// day reads "Sleep, Breakfast, the meeting, Gym". Every block that occurs
// that day appears, eye or not (the eye governs the calendar grid only);
// an overnight block shows twice, each part clipped to the day.

const zone = "America/Los_Angeles";
const day = DateTime.fromISO("2026-10-02", { zone }).startOf("day");
const la = (iso: string) => DateTime.fromISO(iso, { zone }).toUTC().toISO()!;
const block = (over: Partial<Parameters<typeof dayBlockItems>[0][number]>) => ({
  id: "b1",
  title: "Block",
  startTime: la("2026-07-11T07:00"),
  endTime: la("2026-07-11T08:30"),
  timezone: zone,
  recurrenceRule: "FREQ=DAILY",
  visible: false,
  done: false,
  ...over,
});
const hm = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).setZone(zone).toFormat("HH:mm");

describe("dayBlockItems", () => {
  it("expands a daily block onto the day as a lean Reserved row, hidden or not", () => {
    const [row] = dayBlockItems([block({ title: "Breakfast", visible: false })], day);
    expect(row.kind).toBe("block");
    expect(row.title).toBe("Breakfast");
    expect(row.blockId).toBe("b1");
    expect(hm(row.start)).toBe("07:00");
    expect(hm(row.end)).toBe("08:30");
    // Crossing off is per occurrence through the check-off store; the block
    // record's series-wide `done` is never copied onto a day's row.
    expect(row.done).toBeUndefined();
  });

  it("shows an overnight block twice, each part clipped to the day", () => {
    const rows = dayBlockItems(
      [block({ id: "s", title: "Sleep", startTime: la("2026-07-11T23:00"), endTime: la("2026-07-12T07:00"), done: true })],
      day
    );
    expect(rows.map((r) => [hm(r.start), hm(r.end)])).toEqual([
      ["00:00", "07:00"],
      ["23:00", "23:59"],
    ]);
    expect(rows.every((r) => r.done === undefined)).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("skips a block that does not occur that day", () => {
    const weekdays = block({ recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" });
    expect(dayBlockItems([weekdays], DateTime.fromISO("2026-10-03", { zone }))).toEqual([]); // Saturday
    expect(dayBlockItems([weekdays], day)).toHaveLength(1); // Friday
  });

  it("skips a rule that has ended", () => {
    expect(dayBlockItems([block({ recurrenceRule: "FREQ=DAILY;UNTIL=20260103T075959Z" })], day)).toEqual([]);
  });
});

describe("mergeTimeline", () => {
  const item = (key: string, start: string, end: string, allDay = false): AgendaItem => ({
    key, kind: "event", title: key, start: la(start), end: la(end), allDay, colorVar: "--x",
  });
  it("orders everything by clock time, all-day last (the same order Sections uses)", () => {
    const merged = mergeTimeline(
      [item("meeting", "2026-10-02T09:00", "2026-10-02T10:00"), item("bday", "2026-10-02T00:00", "2026-10-03T00:00", true)],
      dayBlockItems([block({ title: "Breakfast" }), block({ id: "g", title: "Gym", startTime: la("2026-07-11T12:30"), endTime: la("2026-07-11T14:30") })], day)
    );
    expect(merged.map((m) => m.title)).toEqual(["Breakfast", "meeting", "Gym", "bday"]);
  });
});
