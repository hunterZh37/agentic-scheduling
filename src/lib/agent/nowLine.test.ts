import { describe, it, expect } from "vitest";
import { nowLine } from "./run";

// Regression: in the evening in the owner's timezone the UTC calendar date
// has already advanced to the next day. The agent's "now" line must anchor
// "today" to the owner's local day, or "what's on my calendar today?"
// answers against the wrong (empty) UTC day. See the WhatsApp report of an
// empty schedule late in the evening, local time.
describe("nowLine", () => {
  it("reports the local (America/New_York) date, not the UTC date, in the evening", () => {
    // 02:44 UTC on Jul 13 == 22:44 EDT on Jul 12.
    const line = nowLine(new Date("2026-07-13T02:44:00Z"));
    expect(line).toContain("July 12, 2026");
    expect(line).not.toContain("July 13, 2026");
  });

  it("still includes the precise UTC instant for range math", () => {
    const line = nowLine(new Date("2026-07-13T02:44:00Z"));
    expect(line).toContain("2026-07-13T02:44:00.000Z");
  });

  it("instructs the model to interpret relative dates in the owner's timezone", () => {
    const line = nowLine(new Date("2026-07-13T02:44:00Z"));
    expect(line).toContain("America/New_York");
    expect(line.toLowerCase()).toContain("today");
  });
});
