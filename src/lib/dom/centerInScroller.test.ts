import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { centeredScrollTop, nearestScroller } from "./centerInScroller";

// The Today list auto-centres the now-line once. It used scrollIntoView, which
// scrolls EVERY scrollable ancestor to centre the element, so it also moved the
// pane behind the list. The list has overscroll-behavior: contain, so a wheel
// over it could never move the pane back: rows sat hidden under the sticky
// "Today" header and the sections below stayed out of reach (owner,
// 2026-09-22). See docs/REGRESSIONS.md.

const rect = (top: number, height: number) => ({ top, height, bottom: top + height });

describe("centeredScrollTop", () => {
  it("scrolls the list so the element sits in the middle of its viewport", () => {
    const list = { scrollTop: 0, clientHeight: 300, getBoundingClientRect: () => rect(100, 300) };
    const el = { offsetHeight: 20, getBoundingClientRect: () => rect(600, 20) };
    // element is 500px below the list top; centre = 500 - (300 - 20) / 2 = 360
    expect(centeredScrollTop(list, el)).toBe(360);
  });

  it("accounts for scroll already applied", () => {
    const list = { scrollTop: 120, clientHeight: 300, getBoundingClientRect: () => rect(100, 300) };
    const el = { offsetHeight: 20, getBoundingClientRect: () => rect(600, 20) };
    expect(centeredScrollTop(list, el)).toBe(480);
  });

  it("never returns a negative scroll", () => {
    const list = { scrollTop: 0, clientHeight: 300, getBoundingClientRect: () => rect(100, 300) };
    const el = { offsetHeight: 20, getBoundingClientRect: () => rect(110, 20) };
    expect(centeredScrollTop(list, el)).toBe(0);
  });
});

describe("nearestScroller", () => {
  type Node = { parentElement: Node | null; overflowY: string };
  const styleOf = (n: Node) => ({ overflowY: n.overflowY });
  it("returns the closest ancestor that scrolls, not the outer pane", () => {
    const pane: Node = { parentElement: null, overflowY: "auto" };
    const list: Node = { parentElement: pane, overflowY: "auto" };
    const li: Node = { parentElement: list, overflowY: "visible" };
    expect(nearestScroller(li, styleOf)).toBe(list);
  });
  it("returns null when nothing scrolls", () => {
    const root: Node = { parentElement: null, overflowY: "visible" };
    const li: Node = { parentElement: root, overflowY: "visible" };
    expect(nearestScroller(li, styleOf)).toBeNull();
  });
});

describe("the agenda never uses scrollIntoView", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../../components/blocks", rel), "utf8");

  it("BlocksPane centres the now-line by setting the list's own scrollTop", () => {
    const src = read("BlocksPane.tsx");
    // The one-shot auto-scroll effect, delimited by its guard and its arm.
    const from = src.indexOf("if (didAutoScrollRef.current) return;");
    const to = src.indexOf("didAutoScrollRef.current = true;");
    expect(from, "auto-scroll effect not found: keep the didAutoScrollRef guard/arm pair").toBeGreaterThan(-1);
    expect(to, "auto-scroll effect not found: keep the didAutoScrollRef guard/arm pair").toBeGreaterThan(from);
    const effect = src.slice(from, to);
    expect(effect).not.toMatch(/scrollIntoView\(/);
    expect(effect).toMatch(/centeredScrollTop\(/);
  });

  it("the inner agenda list chains scrolling to the pane at its ends", () => {
    const css = read("BlocksPane.module.css");
    // Every rule block whose selector list names .agendaList.
    const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => /(^|[\s,])\.agendaList(\s|,|$)/.test(m[1].trim()))
      .map((m) => m[2]);
    expect(blocks.length, ".agendaList rule not found in BlocksPane.module.css").toBeGreaterThan(0);
    for (const b of blocks) expect(b).not.toMatch(/overscroll-behavior:\s*contain/);
  });
});
