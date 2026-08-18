import { describe, it, expect } from "vitest";
import { parseLocalSlot, checkSlots } from "./slotCheck";

describe("parseLocalSlot", () => {
  it("parses pm/am labels in the given zone to the right UTC instant", () => {
    // 11:00pm PDT on 2026-07-13 = 2026-07-14T06:00Z (UTC-7 in July).
    expect(parseLocalSlot("2026-07-13", "11:00pm", "America/Los_Angeles")!.toUTC().toISO())
      .toBe("2026-07-14T06:00:00.000Z");
    // 12am -> midnight local.
    expect(parseLocalSlot("2026-07-13", "12am", "America/Los_Angeles")!.toUTC().toISO())
      .toBe("2026-07-13T07:00:00.000Z");
    // 12pm -> noon local.
    expect(parseLocalSlot("2026-07-13", "12pm", "America/Los_Angeles")!.toUTC().toISO())
      .toBe("2026-07-13T19:00:00.000Z");
  });

  it("returns null for junk", () => {
    expect(parseLocalSlot("2026-07-13", "not a time", "UTC")).toBeNull();
    expect(parseLocalSlot("2026-07-13", "25:00pm", "UTC")).toBeNull();
  });
});

describe("checkSlots", () => {
  const date = "2026-07-13";
  const tz = "America/Los_Angeles";
  // Busy 4:07pm–10:00pm PDT = 23:07Z–05:00Z(next day).
  const busy = [
    { start: new Date("2026-07-13T23:07:00Z"), end: new Date("2026-07-14T05:00:00Z") },
  ];

  it("flags overlapping slots busy and the rest free", () => {
    const res = checkSlots({
      date,
      timezone: tz,
      durationMinutes: 15,
      slots: ["9:30pm", "11:00pm", "11:30pm"],
      busy,
    });
    expect(res.map((r) => [r.slot, r.free])).toEqual([
      ["9:30pm", false], // 21:30 PDT is inside the busy block
      ["11:00pm", true], // 23:00 PDT is after 10:00pm
      ["11:30pm", true],
    ]);
  });

  it("marks unparseable slots not-free with null start", () => {
    const [r] = checkSlots({ date, timezone: tz, durationMinutes: 15, slots: ["???"], busy });
    expect(r).toEqual({ slot: "???", start: null, free: false });
  });
});
