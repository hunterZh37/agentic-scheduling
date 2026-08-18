import { Interval, mergeIntervals, subtractFromInterval } from "./interval";

export interface SlotOptions {
  durationMinutes: number;
  /// Required clearance from any busy interval, applied on both sides.
  bufferMinutes: number;
  /// Distance between consecutive candidate slot starts. Defaults to the slot
  /// duration (back-to-back candidates).
  stepMinutes?: number;
  /// Round each gap's first slot start up to this clock grid (UTC), for tidy
  /// times. 0 disables alignment. Defaults to 15.
  alignMinutes?: number;
}

const MIN = 60_000;

function ceilToGrid(d: Date, minutes: number): Date {
  if (minutes <= 0) return d;
  const step = minutes * MIN;
  return new Date(Math.ceil(d.getTime() / step) * step);
}

/// Grow each busy interval by `bufferMinutes` on both sides, so any surviving
/// free slot keeps that clearance from real busy time. Merged afterward.
function inflate(busy: Interval[], bufferMinutes: number): Interval[] {
  if (bufferMinutes <= 0) return mergeIntervals(busy);
  const pad = bufferMinutes * MIN;
  return mergeIntervals(
    busy.map((b) => ({
      start: new Date(b.start.getTime() - pad),
      end: new Date(b.end.getTime() + pad),
    }))
  );
}

/// Compute bookable slots inside `open` given `busy`, honoring duration and
/// buffer. Pure and deterministic — the caller supplies the already-clamped
/// open range and the full busy set.
export function computeFreeSlots(
  open: Interval,
  busy: Interval[],
  opts: SlotOptions
): Interval[] {
  const duration = opts.durationMinutes * MIN;
  if (duration <= 0) return [];
  const step = (opts.stepMinutes ?? opts.durationMinutes) * MIN;
  const align = opts.alignMinutes ?? 15;

  const gaps = subtractFromInterval(open, inflate(busy, opts.bufferMinutes));
  const slots: Interval[] = [];
  for (const gap of gaps) {
    let t = ceilToGrid(gap.start, align).getTime();
    const gapEnd = gap.end.getTime();
    while (t + duration <= gapEnd) {
      slots.push({ start: new Date(t), end: new Date(t + duration) });
      t += step;
    }
  }
  return slots;
}
