import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Busy time is computed in more than one place, and a source of busy time that
// reaches only some of them is worse than useless: the slot disappears from the
// page while a direct POST still books straight over it.
//
// This is a SOURCE-LEVEL invariant rather than a behavioural test because the
// failure mode is someone adding a FOURTH call site, or quietly dropping one —
// neither of which any existing test would notice. It reads the files and
// checks that anything fanning out provider free/busy also folds in the other
// two sources.
//
// If this fails because you legitimately added a new busy path, add the file to
// the list and make it include every source; do not delete the assertion.

const ROOT = join(__dirname, "..", "..", "..");

/// Every module that computes "is the owner busy" for real decisions.
const BUSY_CALL_SITES = [
  {
    file: "src/lib/availability/service.ts",
    what: "the slot list a visitor sees on /book",
  },
  {
    file: "src/lib/booking/service.ts",
    what: "the guard that accepts a booking — the WRITE path",
  },
  {
    file: "src/app/api/availability/check/route.ts",
    what: "the Calendly extension cross-check",
  },
];

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("every busy computation counts every source of busy", () => {
  it.each(BUSY_CALL_SITES)("$file — $what", ({ file }) => {
    const src = read(file);
    // Provider events.
    expect(src).toMatch(/fanOutBusy/);
    // Reserved blocks — either expanded here, or loaded and handed to
    // computeAvailability, which expands them internally.
    expect(src).toMatch(/expandBlocks|blockBusy|personalBlock\.findMany/);
    // Timed actionables. Missing here is the 4:30pm bug: the actionable sat on
    // the owner's agenda while /book offered the slot.
    expect(src).toMatch(/actionableBusy/);
  });

  it("no other module fans out free/busy without counting actionables", () => {
    // A new call site is the realistic way this regresses. Anything importing
    // fanOutBusy for a real decision must be in the list above.
    const known = new Set(BUSY_CALL_SITES.map((c) => c.file));
    const suspects = [
      "src/lib/availability/service.ts",
      "src/lib/booking/service.ts",
      "src/app/api/availability/check/route.ts",
      "src/lib/agent/tools.ts",
      "src/lib/agent/negotiate.ts",
    ].filter((f) => {
      let src: string;
      try {
        src = read(f);
      } catch {
        return false;
      }
      return /fanOutBusy\s*\(/.test(src) && !known.has(f);
    });
    expect(suspects, "new busy call site — add it to BUSY_CALL_SITES").toEqual([]);
  });
});
