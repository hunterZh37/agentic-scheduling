import { describe, expect, it } from "vitest";
import { whenRow, editedTimes } from "./whenRow";

const TZ = "America/Los_Angeles";
const start = new Date("2026-09-22T16:00:00.000Z"); // 9:00 AM Pacific
const end = new Date("2026-09-22T16:30:00.000Z");

describe("whenRow", () => {
  it("shows date, time range and zone for a timed item", () => {
    const r = whenRow({ start, end }, TZ);
    expect(r.date).toBe("Tuesday, September 22");
    expect(r.time).toBe("9:00 – 9:30 AM · America/Los_Angeles");
  });

  it("shows the date and NO time for an untimed actionable", () => {
    const midnight = new Date("2026-09-22T07:00:00.000Z");
    const r = whenRow({ start: midnight, end: midnight, untimed: true }, TZ);
    expect(r.date).toBe("Tuesday, September 22");
    expect(r.time).toBe("No time set");
    expect(r.time).not.toMatch(/\d/);
  });
});

describe("editedTimes", () => {
  it("both empty keeps or makes it untimed", () => {
    expect(editedTimes({ date: "2026-09-22", start: "", end: "" }, TZ)).toEqual({
      kind: "untimed",
      date: "2026-09-22T07:00:00.000Z",
    });
  });

  it("both filled sets a range", () => {
    const r = editedTimes({ date: "2026-09-22", start: "09:00", end: "09:30" }, TZ);
    expect(r).toEqual({ kind: "timed", date: "2026-09-22T07:00:00.000Z", start: "2026-09-22T16:00:00.000Z", end: "2026-09-22T16:30:00.000Z" });
  });

  it("one end filled is refused, never silently saved as a time or as untimed", () => {
    const r = editedTimes({ date: "2026-09-22", start: "09:00", end: "" }, TZ);
    expect(r.kind).toBe("error");
  });

  it("clearing both fields on a timed item also yields untimed", () => {
    const r = editedTimes({ date: "2026-09-22", start: "", end: "" }, TZ);
    expect(r.kind).toBe("untimed");
  });

  it("end before start is an overnight range, as before", () => {
    const r = editedTimes({ date: "2026-09-22", start: "23:00", end: "01:00" }, TZ);
    expect(r).toEqual({ kind: "timed", date: "2026-09-22T07:00:00.000Z", start: "2026-09-23T06:00:00.000Z", end: "2026-09-23T08:00:00.000Z" });
  });
});
