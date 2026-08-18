import { describe, it, expect } from "vitest";
import { followupKey } from "./key";

describe("followupKey", () => {
  const start = new Date("2026-07-31T18:00:00.000Z");

  it("builds the key from a bare provider id", () => {
    expect(followupKey("AAMkabc", start)).toBe("event:AAMkabc:2026-07-31T18:00:00.000Z");
  });

  it("normalizes an id that already carries the event: prefix", () => {
    expect(followupKey("event:AAMkabc", start)).toBe("event:AAMkabc:2026-07-31T18:00:00.000Z");
  });

  it("matches the two id forms to the same key", () => {
    expect(followupKey("event:AAMkabc", start)).toBe(followupKey("AAMkabc", start));
  });

  it("uses a stable ISO start so different occurrences differ", () => {
    const later = new Date("2026-08-07T18:00:00.000Z");
    expect(followupKey("AAMkabc", later)).not.toBe(followupKey("AAMkabc", start));
  });
});
