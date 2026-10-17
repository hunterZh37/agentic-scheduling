import { describe, it, expect } from "vitest";
import { scrollEdges, countHiddenBelow } from "./scrollEdges";

// A scroller that has more content than it shows must say so: a fade at the
// bottom while there is more below, at the top while there is more above
// (owner, 2026-10-02: "there should be a visual indicator that there is more
// to come"). The DOM wiring is thin; this pins the rule it uses.

describe("scrollEdges", () => {
  it("nothing to scroll: no edges", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toEqual({ above: false, below: false });
  });
  it("at the top with more content: below only", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 })).toEqual({ above: false, below: true });
  });
  it("in the middle: both", () => {
    expect(scrollEdges({ scrollTop: 200, scrollHeight: 900, clientHeight: 400 })).toEqual({ above: true, below: true });
  });
  it("at the bottom: above only, tolerant of sub-pixel rounding", () => {
    expect(scrollEdges({ scrollTop: 499.6, scrollHeight: 900, clientHeight: 400 })).toEqual({ above: true, below: false });
  });
  it("a few pixels short of either edge still counts as at that edge (no flicker on the last pixel)", () => {
    expect(scrollEdges({ scrollTop: 2, scrollHeight: 900, clientHeight: 400 }).above).toBe(false);
    expect(scrollEdges({ scrollTop: 497, scrollHeight: 900, clientHeight: 400 }).below).toBe(false);
  });
});

// "It's really hard to tell that there are remaining items" (owner,
// 2026-10-16): the fade alone was too quiet on a dark surface. The pane now
// says how many rows are below the fold; this pins the count.
describe("countHiddenBelow", () => {
  it("counts rows whose top edge is at or past the visible bottom", () => {
    expect(countHiddenBelow([10, 60, 110, 160, 210], 150)).toBe(2);
  });
  it("a row that starts within the slack of the bottom is hidden too: nothing of it reads", () => {
    expect(countHiddenBelow([10, 147], 150)).toBe(1);
    expect(countHiddenBelow([10, 140], 150)).toBe(0);
  });
  it("nothing below: zero", () => {
    expect(countHiddenBelow([10, 60], 150)).toBe(0);
    expect(countHiddenBelow([], 150)).toBe(0);
  });
});

