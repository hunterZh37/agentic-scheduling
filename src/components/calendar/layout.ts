import { DateTime } from "luxon";

export interface TimedItem {
  start: Date; // UTC
  end: Date; // UTC
}

export interface Positioned<T extends TimedItem> {
  item: T;
  top: number; // px from grid top
  height: number; // px
  laneIndex: number; // column within an overlapping cluster
  laneCount: number; // total columns in that cluster
  clippedTop: boolean; // starts before the grid window
  clippedBottom: boolean; // ends after the grid window
}

const MIN_HEIGHT = 18;

/// Wall-clock hours of `dt` relative to `day`'s local midnight: the number of
/// whole local calendar days between them times 24, plus the local
/// hour/minute/second within `dt`'s own day. Unlike `dt.diff(day, "hours")`
/// (elapsed duration), this stays a linear 1h-per-hourPx mapping across DST
/// transitions, since a "spring forward" or "fall back" day is still exactly
/// 24 grid-hours wide even though it's 23 or 25 elapsed hours long.
function wallClockHours(dt: DateTime, day: DateTime): number {
  const dayIndex = Math.round(dt.startOf("day").diff(day, "days").days);
  return dayIndex * 24 + dt.hour + dt.minute / 60 + dt.second / 3600;
}

/// Position a day's items into a column, resolving overlaps into side-by-side
/// lanes. `day` is local midnight in `zone`; the window is [startHour, endHour].
export function layoutDay<T extends TimedItem>(
  items: T[],
  day: DateTime,
  zone: string,
  startHour: number,
  endHour: number,
  hourPx: number
): Positioned<T>[] {
  const gridBottom = (endHour - startHour) * hourPx;

  const placed: Positioned<T>[] = [];
  for (const item of items) {
    const s = DateTime.fromJSDate(item.start, { zone: "utc" }).setZone(zone);
    const e = DateTime.fromJSDate(item.end, { zone: "utc" }).setZone(zone);
    // Decimal hours from the day's local midnight, positioned by WALL-CLOCK
    // time (not elapsed duration) so DST transitions don't skew the fixed
    // hourPx grid: each whole local calendar day past `day` adds a flat 24h,
    // then we add the local hour/minute within that day.
    const startH = wallClockHours(s, day);
    const endH = wallClockHours(e, day);
    if (endH <= startHour || startH >= endHour) continue; // outside the window

    const clampedStart = Math.max(startH, startHour);
    const clampedEnd = Math.min(endH, endHour);
    const top = (clampedStart - startHour) * hourPx;
    const height = Math.max(MIN_HEIGHT, (clampedEnd - clampedStart) * hourPx);

    placed.push({
      item,
      top,
      height: Math.min(height, gridBottom - top),
      laneIndex: 0,
      laneCount: 1,
      clippedTop: startH < startHour,
      clippedBottom: endH > endHour,
    });
  }

  // Overlap resolution: sweep in start order, group into clusters of mutually
  // overlapping items, assign each the first free lane, and set laneCount to
  // the cluster's width.
  placed.sort((a, b) => a.top - b.top || b.height - a.height);
  let cluster: Positioned<T>[] = [];
  let clusterBottom = -Infinity;

  const finalize = () => {
    const laneCount = cluster.reduce((m, p) => Math.max(m, p.laneIndex + 1), 0);
    for (const p of cluster) p.laneCount = laneCount;
    cluster = [];
  };

  const laneEnds: number[] = [];
  for (const p of placed) {
    if (p.top >= clusterBottom) {
      finalize();
      laneEnds.length = 0;
      clusterBottom = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= p.top);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = p.top + p.height;
    p.laneIndex = lane;
    cluster.push(p);
    clusterBottom = Math.max(clusterBottom, p.top + p.height);
  }
  finalize();

  return placed;
}
