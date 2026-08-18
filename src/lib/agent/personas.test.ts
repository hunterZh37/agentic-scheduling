import { describe, it, expect } from "vitest";
import { PERSONAS, pickPersona } from "./personas";

describe("personas", () => {
  it("has at least 3 well-formed personas", () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(3);
    for (const p of PERSONAS) {
      expect(p.name).toBeTruthy();
      expect(p.email).toMatch(/@/);
      expect(p.goal).toBeTruthy();
      expect(p.durationMinutes).toBeGreaterThan(0);
      expect(p.timezone).toBeTruthy();
      expect(p.availability).toBeTruthy();
    }
  });

  it("pickPersona wraps by modulo and handles out-of-range", () => {
    expect(pickPersona(0)).toBe(PERSONAS[0]);
    expect(pickPersona(PERSONAS.length)).toBe(PERSONAS[0]);
    expect(pickPersona(PERSONAS.length + 1)).toBe(PERSONAS[1]);
  });
});
