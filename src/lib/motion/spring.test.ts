import { describe, it, expect } from "vitest";
import { project, rubberband, shouldDismissSheet } from "./spring";

// These drive the feel of the bottom sheet — get them wrong and a gentle drag
// throws the sheet closed, or a hard flick springs back. Pin the decisions.

describe("project (momentum)", () => {
  it("throws further the faster the flick", () => {
    expect(project(2000)).toBeGreaterThan(project(500));
  });
  it("carries the sign of the velocity", () => {
    expect(project(-800)).toBeLessThan(0);
    expect(project(0)).toBe(0);
  });
});

describe("rubberband (soft boundary)", () => {
  it("returns less than the raw overshoot (resistance)", () => {
    expect(Math.abs(rubberband(100, 600))).toBeLessThan(100);
  });
  it("keeps resisting harder the further past the edge", () => {
    const near = Math.abs(rubberband(50, 600));
    const far = Math.abs(rubberband(400, 600));
    // Absolute offset still grows, but the *ratio* followed shrinks.
    expect(far).toBeGreaterThan(near);
    expect(far / 400).toBeLessThan(near / 50);
  });
});

describe("shouldDismissSheet", () => {
  const height = 600;
  it("dismisses on a decisive downward flick, even from near the top", () => {
    expect(shouldDismissSheet({ offset: 40, velocity: 1500, height })).toBe(true);
  });
  it("keeps the sheet on an upward flick, even when dragged far", () => {
    expect(shouldDismissSheet({ offset: 400, velocity: -600, height })).toBe(false);
  });
  it("springs back a small, slow drag", () => {
    expect(shouldDismissSheet({ offset: 80, velocity: 0, height })).toBe(false);
  });
  it("dismisses once dragged well past halfway at rest", () => {
    expect(shouldDismissSheet({ offset: 380, velocity: 0, height })).toBe(true);
  });
});
