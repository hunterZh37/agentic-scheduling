import { describe, it, expect } from "vitest";
import {
  resolveBookableRange,
  computeAvailability,
  type AvailabilitySettings,
} from "./index";

const d = (iso: string) => new Date(iso);
const starts = (list: { start: Date }[]) => list.map((i) => i.start.toISOString());

const SETTINGS: AvailabilitySettings = {
  bookingHorizonDays: 60,
  minNoticeHours: 2,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
};

describe("resolveBookableRange", () => {
  it("floors at now + minNotice and caps at now + horizon", () => {
    const range = resolveBookableRange(
      d("2026-01-01T00:00:00Z"),
      d("2026-01-01T00:00:00Z"),
      d("2026-04-01T00:00:00Z"),
      SETTINGS
    );
    expect(range).not.toBeNull();
    expect(range!.start.toISOString()).toBe("2026-01-01T02:00:00.000Z"); // +2h notice
    expect(range!.end.toISOString()).toBe("2026-03-02T00:00:00.000Z"); // +60 days
  });

  it("returns null when the requested range is entirely in the past", () => {
    const range = resolveBookableRange(
      d("2026-01-10T00:00:00Z"),
      d("2026-01-01T00:00:00Z"),
      d("2026-01-05T00:00:00Z"),
      SETTINGS
    );
    expect(range).toBeNull();
  });
});

describe("computeAvailability — end to end", () => {
  it("subtracts both provider busy and personal blocks, then slices", () => {
    const slots = computeAvailability({
      now: d("2026-06-01T12:00:00Z"),
      requestedStart: d("2026-06-02T13:00:00Z"),
      requestedEnd: d("2026-06-02T15:00:00Z"),
      settings: SETTINGS,
      providerBusy: [{ start: d("2026-06-02T13:30:00Z"), end: d("2026-06-02T14:00:00Z") }],
      blocks: [
        {
          startTime: d("2026-06-02T14:30:00Z"),
          endTime: d("2026-06-02T15:00:00Z"),
          timezone: "America/Los_Angeles",
          recurrenceRule: null,
        },
      ],
    });
    // 13:00-13:30 free, 13:30-14:00 provider-busy, 14:00-14:30 free,
    // 14:30-15:00 block-busy.
    expect(starts(slots)).toEqual([
      "2026-06-02T13:00:00.000Z",
      "2026-06-02T14:00:00.000Z",
    ]);
  });

  it("yields no slots when min-notice pushes the floor past the requested end", () => {
    const slots = computeAvailability({
      now: d("2026-06-02T13:15:00Z"),
      requestedStart: d("2026-06-02T13:00:00Z"),
      requestedEnd: d("2026-06-02T15:00:00Z"),
      settings: SETTINGS, // +2h notice -> floor 15:15Z, past the 15:00Z end
      providerBusy: [],
      blocks: [],
    });
    expect(slots).toEqual([]);
  });
});
