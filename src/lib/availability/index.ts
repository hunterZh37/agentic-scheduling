import { Interval, clampInterval } from "./interval";
import { computeFreeSlots, SlotOptions } from "./slots";
import { expandBlocks, RecurringBlock } from "./recurrence";

export type { Interval } from "./interval";
export { mergeIntervals, subtractFromInterval } from "./interval";
export { computeFreeSlots } from "./slots";
export { expandBlock, expandBlocks } from "./recurrence";
export type { RecurringBlock } from "./recurrence";

/// The availability-relevant slice of Settings.
export interface AvailabilitySettings {
  bookingHorizonDays: number;
  minNoticeHours: number;
  bufferMinutes: number;
  defaultEventDurationMinutes: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/// Clamp a requested range to the bookable window: never earlier than
/// now + minNoticeHours, never later than now + bookingHorizonDays.
export function resolveBookableRange(
  now: Date,
  requestedStart: Date,
  requestedEnd: Date,
  settings: AvailabilitySettings
): Interval | null {
  const floor = new Date(now.getTime() + settings.minNoticeHours * HOUR_MS);
  const ceil = new Date(now.getTime() + settings.bookingHorizonDays * DAY_MS);
  return clampInterval({ start: requestedStart, end: requestedEnd }, floor, ceil);
}

export interface ComputeAvailabilityInput {
  now: Date;
  requestedStart: Date;
  requestedEnd: Date;
  settings: AvailabilitySettings;
  /// Busy intervals fanned out from calendar providers (already UTC).
  providerBusy: Interval[];
  /// Personal blocks to expand against the range.
  blocks: RecurringBlock[];
  /// Optional overrides for slot slicing (step/alignment).
  slotOverrides?: Partial<Pick<SlotOptions, "stepMinutes" | "alignMinutes">>;
}

/// The full availability algorithm (steps 1–6 of the spec), minus the live
/// fan-out — provider busy + blocks are passed in so this stays pure/testable.
export function computeAvailability(input: ComputeAvailabilityInput): Interval[] {
  const range = resolveBookableRange(
    input.now,
    input.requestedStart,
    input.requestedEnd,
    input.settings
  );
  if (!range) return [];

  const blockBusy = expandBlocks(input.blocks, range.start, range.end);
  const busy = [...input.providerBusy, ...blockBusy];

  return computeFreeSlots(range, busy, {
    durationMinutes: input.settings.defaultEventDurationMinutes,
    bufferMinutes: input.settings.bufferMinutes,
    stepMinutes: input.slotOverrides?.stepMinutes,
    alignMinutes: input.slotOverrides?.alignMinutes,
  });
}
