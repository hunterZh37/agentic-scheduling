import { describe, it, expect } from "vitest";
import { leadTimeFireAt } from "./leadTime";

describe("leadTimeFireAt", () => {
  const start = "2026-07-20T19:30:00.000Z"; // 12:30 PDT
  it("'at' returns the start instant", () => {
    expect(leadTimeFireAt(start, "at")).toBe("2026-07-20T19:30:00.000Z");
  });
  it("subtracts 10 min / 1 hr / 1 day", () => {
    expect(leadTimeFireAt(start, "m10")).toBe("2026-07-20T19:20:00.000Z");
    expect(leadTimeFireAt(start, "h1")).toBe("2026-07-20T18:30:00.000Z");
    expect(leadTimeFireAt(start, "d1")).toBe("2026-07-19T19:30:00.000Z");
  });
  it("custom returns the normalized custom instant", () => {
    expect(leadTimeFireAt(null, "custom", "2026-07-21T09:00:00Z")).toBe("2026-07-21T09:00:00.000Z");
  });
  it("returns null when a preset needs a start but none is given", () => {
    expect(leadTimeFireAt(null, "m10")).toBeNull();
  });
  it("returns null for invalid inputs", () => {
    expect(leadTimeFireAt("nope", "at")).toBeNull();
    expect(leadTimeFireAt(null, "custom", "bad")).toBeNull();
    expect(leadTimeFireAt(null, "custom")).toBeNull();
  });
});
