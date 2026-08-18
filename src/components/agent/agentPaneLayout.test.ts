import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression #59: the Alex composer floats over the thread (position:absolute,
// bottom:0) and its padding reserves env(safe-area-inset-bottom). On a notched
// phone that makes the composer ~34px taller than a fixed reservation, so if the
// scroll thread does NOT reserve the same inset, the last ~34px of the
// conversation hides behind the composer and can't be scrolled to. The invariant
// this guards: whenever the composer consumes the safe-area inset, the thread
// must reserve it too. Device-only visually (env() is 0 headless), so this
// structural check is the guard the mobile audit can't be.
const css = readFileSync(
  fileURLToPath(new URL("./AgentPane.module.css", import.meta.url)),
  "utf8"
);

// Concatenate every rule body for an exact selector (a selector can appear more
// than once — e.g. a base rule plus a media-query override), so a `toContain`
// check passes when any of them declares the property.
function block(selector: string): string {
  const bodies: string[] = [];
  let i = 0;
  while ((i = css.indexOf(selector + " {", i)) !== -1) {
    const open = css.indexOf("{", i);
    const close = css.indexOf("}", open);
    bodies.push(css.slice(open + 1, close));
    i = close + 1;
  }
  expect(bodies.length, `${selector} rule exists`).toBeGreaterThan(0);
  return bodies.join("\n");
}

describe("AgentPane mobile layout", () => {
  const INSET = "env(safe-area-inset-bottom)";

  it("the floating composer reserves the safe-area inset", () => {
    expect(block(".composer")).toContain(INSET);
  });

  it("the scroll thread reserves the same inset so the last message clears the composer", () => {
    const thread = block(".thread");
    expect(thread).toMatch(/padding:/);
    // If the composer reserves the inset, the thread's bottom padding must too,
    // or content scrolls behind the composer on notched phones.
    expect(thread).toContain(INSET);
  });
});
