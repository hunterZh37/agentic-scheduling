// Pure interval math over [start, end) UTC instants. No I/O, no dates-from-now:
// every function here is deterministic and unit-tested with fixtures.

export interface Interval {
  start: Date;
  end: Date;
}

const ms = (d: Date) => d.getTime();

/// True if the interval has positive duration.
export function isValid(i: Interval): boolean {
  return ms(i.end) > ms(i.start);
}

/// Merge overlapping/adjacent intervals into a minimal sorted set.
/// Adjacent (end === next.start) intervals are coalesced.
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter(isValid).sort((a, b) => ms(a.start) - ms(b.start));
  const out: Interval[] = [];
  for (const cur of valid) {
    const last = out[out.length - 1];
    if (last && ms(cur.start) <= ms(last.end)) {
      // Overlaps or touches the running interval — extend it.
      if (ms(cur.end) > ms(last.end)) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/// Subtract a set of busy intervals from a single open interval, returning the
/// remaining free gaps in order.
export function subtractFromInterval(open: Interval, busy: Interval[]): Interval[] {
  if (!isValid(open)) return [];
  const merged = mergeIntervals(busy);
  const gaps: Interval[] = [];
  let cursor = open.start;

  for (const b of merged) {
    if (ms(b.end) <= ms(cursor)) continue; // entirely before the cursor
    if (ms(b.start) >= ms(open.end)) break; // beyond the open interval
    if (ms(b.start) > ms(cursor)) {
      gaps.push({ start: cursor, end: new Date(Math.min(ms(b.start), ms(open.end))) });
    }
    if (ms(b.end) > ms(cursor)) cursor = b.end;
    if (ms(cursor) >= ms(open.end)) break;
  }
  if (ms(cursor) < ms(open.end)) {
    gaps.push({ start: cursor, end: open.end });
  }
  return gaps.filter(isValid);
}

/// Clamp an interval to [lo, hi], returning null if the result is empty.
export function clampInterval(i: Interval, lo: Date, hi: Date): Interval | null {
  const start = new Date(Math.max(ms(i.start), ms(lo)));
  const end = new Date(Math.min(ms(i.end), ms(hi)));
  return ms(end) > ms(start) ? { start, end } : null;
}
