import { describe, it, expect } from "vitest";
import { greetingWord } from "./greeting";

// Owner-dashboard critique (2026-08-19): the agent greeting was a hardcoded
// "Morning" that showed at 12:01 PM. These pin the time-of-day boundaries.
describe("greetingWord", () => {
  it("is Morning before noon", () => {
    expect(greetingWord(0)).toBe("Morning");
    expect(greetingWord(6)).toBe("Morning");
    expect(greetingWord(11)).toBe("Morning");
  });

  it("is Afternoon from noon until 5pm", () => {
    expect(greetingWord(12)).toBe("Afternoon");
    expect(greetingWord(16)).toBe("Afternoon");
  });

  it("is Evening from 5pm on", () => {
    expect(greetingWord(17)).toBe("Evening");
    expect(greetingWord(23)).toBe("Evening");
  });
});
