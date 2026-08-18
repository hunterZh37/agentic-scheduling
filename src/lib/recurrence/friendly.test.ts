import { describe, it, expect } from "vitest";
import { presetToRule, detectPreset, friendlyRecurrence, type RecurrencePreset } from "./friendly";

describe("recurrence presets round-trip", () => {
  const cases: Array<[RecurrencePreset, string, string]> = [
    ["everyday", "FREQ=DAILY", "Every day"],
    ["weekly", "FREQ=WEEKLY", "Weekly"],
    ["weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Weekdays"],
    ["monthly", "FREQ=MONTHLY", "Every month"],
    ["monthlyLast", "FREQ=MONTHLY;BYMONTHDAY=-1", "Every month on the last day"],
  ];
  it.each(cases)("%s -> rule -> label/detect", (preset, rule, label) => {
    expect(presetToRule(preset)).toBe(rule);
    expect(friendlyRecurrence(rule)).toBe(label);
    expect(detectPreset(rule)).toBe(preset);
  });

  it("never has no rule", () => {
    expect(presetToRule("never")).toBeNull();
    expect(friendlyRecurrence(null)).toBe("Once");
    expect(detectPreset(null)).toBe("never");
  });
});
