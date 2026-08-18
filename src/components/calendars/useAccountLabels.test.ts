import { describe, it, expect } from "vitest";
import { toAccountLabels } from "./useAccountLabels";

// Renaming a calendar used to take effect in the Calendars manager and nowhere
// else: the legend, the calendar footer and the event detail each fetched
// /api/accounts and mapped straight to `a.email`, throwing `displayName` away.
// The owner renamed a calendar to "consulting" and still saw the raw address
// everywhere that mattered.

describe("toAccountLabels", () => {
  it("uses the owner's alias when one is set", () => {
    expect(
      toAccountLabels([{ email: "hunter@hunterzhangconsulting.com", displayName: "consulting" }])
    ).toEqual([{ email: "hunter@hunterzhangconsulting.com", label: "consulting" }]);
  });

  it("falls back to the address when there is no alias", () => {
    expect(toAccountLabels([{ email: "hunter@example.org", displayName: null }])).toEqual([
      { email: "hunter@example.org", label: "hunter@example.org" },
    ]);
  });

  it("treats a blank alias as no alias", () => {
    // Otherwise a stray space renders as an empty label and the calendar
    // becomes an anonymous coloured dot.
    expect(toAccountLabels([{ email: "a@b.com", displayName: "   " }])).toEqual([
      { email: "a@b.com", label: "a@b.com" },
    ]);
  });

  it("keeps the address alongside the label, since colour keys off it", () => {
    // accountVar(email) gives each calendar its stable colour. Substituting the
    // label there would recolour every calendar the moment it was renamed.
    const [row] = toAccountLabels([{ email: "a@b.com", displayName: "work" }]);
    expect(row.email).toBe("a@b.com");
    expect(row.label).toBe("work");
  });

  it("handles a missing displayName field at all", () => {
    expect(toAccountLabels([{ email: "a@b.com" }])).toEqual([{ email: "a@b.com", label: "a@b.com" }]);
  });
});
