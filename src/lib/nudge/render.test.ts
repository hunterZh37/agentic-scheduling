import { describe, it, expect } from "vitest";
import { renderNudge } from "./render";

const TZ = "America/Los_Angeles";

describe("renderNudge", () => {
  it("renders a fresh line when the event resolved", () => {
    const out = renderNudge(
      { body: "Schedule Planning — bring the roadmap." },
      { title: "Schedule Planning", start: new Date("2026-07-20T19:30:00Z") }, // 12:30 PDT
      TZ
    );
    expect(out).toContain("Schedule Planning");
    expect(out).toContain("12:30");
    expect(out).toContain("bring the roadmap");
  });

  it("returns the snapshot body verbatim when the event did not resolve", () => {
    const body = "Reminder: Schedule Planning at 12:30 PT.";
    expect(renderNudge({ body }, null, TZ)).toBe(body);
  });
});
