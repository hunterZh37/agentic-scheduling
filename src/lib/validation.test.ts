import { describe, it, expect } from "vitest";
import { parseDurationMinutes } from "./validation";

describe("parseDurationMinutes", () => {
  it("accepts the durations the booking UI offers", () => {
    for (const n of [15, 30, 45, 60, 90, 120]) {
      expect(parseDurationMinutes(String(n))).toEqual({ minutes: n });
    }
  });

  it("treats absent values as 'use the configured default'", () => {
    for (const v of [undefined, null, ""]) {
      expect(parseDurationMinutes(v)).toEqual({ minutes: undefined });
    }
  });

  // Regression: `duration=0.5` used to pass the old "finite and > 0" check and
  // produced 960 zero-length slots for a single day on production.
  it("rejects fractional durations", () => {
    expect(parseDurationMinutes("0.5")).toHaveProperty("error");
    expect(parseDurationMinutes(1.5)).toHaveProperty("error");
  });

  it("rejects zero, negative and non-numeric values", () => {
    for (const v of ["0", "-30", "NaN", "abc", "1e", {}, []]) {
      expect(parseDurationMinutes(v)).toHaveProperty("error");
    }
  });

  it("rejects durations outside the sane range", () => {
    expect(parseDurationMinutes("1")).toHaveProperty("error"); // below 5-min floor
    expect(parseDurationMinutes("100000")).toHaveProperty("error"); // beyond 24h
    expect(parseDurationMinutes("1e9")).toHaveProperty("error");
  });

  it("accepts the exact boundaries", () => {
    expect(parseDurationMinutes("5")).toEqual({ minutes: 5 });
    expect(parseDurationMinutes("1440")).toEqual({ minutes: 1440 });
  });
});
