import { describe, it, expect } from "vitest";
import { scrollEdges } from "./scrollEdges";

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
