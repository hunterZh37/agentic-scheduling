import { describe, it, expect } from "vitest";
import { diffItems, progress, progressLabel } from "./items";

const ex = (id: string, title: string, done = false) => ({ id, title, done });

describe("diffItems", () => {
  it("creates items without an id, in order", () => {
    const d = diffItems([], [{ title: "a" }, { title: "b" }]);
    expect(d.create).toEqual([
      { title: "a", done: false, sortOrder: 0 },
      { title: "b", done: false, sortOrder: 1 },
    ]);
    expect(d.update).toEqual([]);
    expect(d.delete).toEqual([]);
  });

  it("updates existing ids by position and content", () => {
    const d = diffItems([ex("1", "a"), ex("2", "b")], [{ id: "2", title: "b!", done: true }, { id: "1", title: "a" }]);
    expect(d.update).toEqual([
      { id: "2", title: "b!", done: true, sortOrder: 0 },
      { id: "1", title: "a", done: false, sortOrder: 1 },
    ]);
    expect(d.create).toEqual([]);
    expect(d.delete).toEqual([]);
  });

  it("deletes ids absent from the incoming list", () => {
    const d = diffItems([ex("1", "a"), ex("2", "b")], [{ id: "2", title: "b" }]);
    expect(d.delete).toEqual(["1"]);
  });

  it("ignores an incoming id it does not own (treats it as new)", () => {
    const d = diffItems([ex("1", "a")], [{ id: "zzz", title: "x" }]);
    expect(d.create).toEqual([{ title: "x", done: false, sortOrder: 0 }]);
    expect(d.delete).toEqual(["1"]);
  });

  it("trims titles and drops empty ones", () => {
    const d = diffItems([], [{ title: "  a  " }, { title: "   " }]);
    expect(d.create).toEqual([{ title: "a", done: false, sortOrder: 0 }]);
  });
});

describe("progress", () => {
  it("counts done over total", () => {
    expect(progress([ex("1", "a", true), ex("2", "b"), ex("3", "c")])).toEqual({ done: 1, total: 3 });
    expect(progress([])).toEqual({ done: 0, total: 0 });
  });
  it("labels as 'd of t', and nothing for an empty list", () => {
    expect(progressLabel({ done: 1, total: 3 })).toBe("1 of 3");
    expect(progressLabel({ done: 0, total: 0 })).toBeNull();
  });
});
