import { describe, it, expect } from "vitest";
import {
  mergeIntervals,
  subtractFromInterval,
  clampInterval,
  type Interval,
} from "./interval";

const d = (iso: string) => new Date(iso);
const iv = (s: string, e: string): Interval => ({ start: d(s), end: d(e) });
const show = (list: Interval[]) =>
  list.map((i) => `${i.start.toISOString()}/${i.end.toISOString()}`);

describe("mergeIntervals", () => {
  it("sorts and coalesces overlapping intervals", () => {
    const merged = mergeIntervals([
      iv("2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"),
      iv("2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z"),
    ]);
    expect(show(merged)).toEqual(["2026-01-01T09:00:00.000Z/2026-01-01T11:00:00.000Z"]);
  });

  it("coalesces touching intervals (end === next.start)", () => {
    const merged = mergeIntervals([
      iv("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"),
      iv("2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"),
    ]);
    expect(show(merged)).toEqual(["2026-01-01T09:00:00.000Z/2026-01-01T11:00:00.000Z"]);
  });

  it("keeps disjoint intervals separate and drops zero-length ones", () => {
    const merged = mergeIntervals([
      iv("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"),
      iv("2026-01-01T12:00:00Z", "2026-01-01T12:00:00Z"), // zero-length
      iv("2026-01-01T11:00:00Z", "2026-01-01T12:00:00Z"),
    ]);
    expect(show(merged)).toEqual([
      "2026-01-01T09:00:00.000Z/2026-01-01T10:00:00.000Z",
      "2026-01-01T11:00:00.000Z/2026-01-01T12:00:00.000Z",
    ]);
  });
});

describe("subtractFromInterval", () => {
  const open = iv("2026-01-01T09:00:00Z", "2026-01-01T17:00:00Z");

  it("returns the whole open interval when nothing is busy", () => {
    expect(show(subtractFromInterval(open, []))).toEqual([
      "2026-01-01T09:00:00.000Z/2026-01-01T17:00:00.000Z",
    ]);
  });

  it("carves out a busy block in the middle", () => {
    const gaps = subtractFromInterval(open, [iv("2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z")]);
    expect(show(gaps)).toEqual([
      "2026-01-01T09:00:00.000Z/2026-01-01T12:00:00.000Z",
      "2026-01-01T13:00:00.000Z/2026-01-01T17:00:00.000Z",
    ]);
  });

  it("clips busy that overhangs both edges", () => {
    const gaps = subtractFromInterval(open, [
      iv("2026-01-01T08:00:00Z", "2026-01-01T10:00:00Z"),
      iv("2026-01-01T16:00:00Z", "2026-01-01T18:00:00Z"),
    ]);
    expect(show(gaps)).toEqual([
      "2026-01-01T10:00:00.000Z/2026-01-01T16:00:00.000Z",
    ]);
  });

  it("returns nothing when busy fully covers the open interval", () => {
    const gaps = subtractFromInterval(open, [iv("2026-01-01T08:00:00Z", "2026-01-01T18:00:00Z")]);
    expect(gaps).toEqual([]);
  });

  it("handles overlapping busy intervals via merge", () => {
    const gaps = subtractFromInterval(open, [
      iv("2026-01-01T11:00:00Z", "2026-01-01T13:00:00Z"),
      iv("2026-01-01T12:00:00Z", "2026-01-01T14:00:00Z"),
    ]);
    expect(show(gaps)).toEqual([
      "2026-01-01T09:00:00.000Z/2026-01-01T11:00:00.000Z",
      "2026-01-01T14:00:00.000Z/2026-01-01T17:00:00.000Z",
    ]);
  });
});

describe("clampInterval", () => {
  it("intersects with the bounds", () => {
    const c = clampInterval(
      iv("2026-01-01T08:00:00Z", "2026-01-01T20:00:00Z"),
      d("2026-01-01T09:00:00Z"),
      d("2026-01-01T17:00:00Z")
    );
    expect(c && show([c])).toEqual(["2026-01-01T09:00:00.000Z/2026-01-01T17:00:00.000Z"]);
  });

  it("returns null when disjoint", () => {
    const c = clampInterval(
      iv("2026-01-01T18:00:00Z", "2026-01-01T20:00:00Z"),
      d("2026-01-01T09:00:00Z"),
      d("2026-01-01T17:00:00Z")
    );
    expect(c).toBeNull();
  });
});
