import { describe, it, expect } from "vitest";
import { firstNamesLabel } from "./resolve";

describe("firstNamesLabel", () => {
  it("joins two hosts' first names with an ampersand", () => {
    expect(firstNamesLabel(["Ben Brooks", "Hunter Zhang"])).toBe("Ben & Hunter");
  });

  it("uses an Oxford-style list for three or more", () => {
    expect(firstNamesLabel(["Ben Brooks", "Hunter Zhang", "Cara Diaz"])).toBe("Ben, Hunter & Cara");
  });

  it("returns the single first name alone", () => {
    expect(firstNamesLabel(["Hunter Zhang"])).toBe("Hunter");
  });

  it("handles empty / whitespace names", () => {
    expect(firstNamesLabel([])).toBe("");
    expect(firstNamesLabel(["  Ben  Brooks "])).toBe("Ben");
  });
});
