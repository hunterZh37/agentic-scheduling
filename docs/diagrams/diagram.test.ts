import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The system diagram is a committed artifact with a committed source. Two
// things can go wrong without anyone noticing: the source stops being a valid
// showcase spec (archify only checks when someone renders), or the HTML is
// left behind after a JSON edit (the post-commit hook renders, but a hook is
// only as reliable as the clone it is enabled in). Both are cheap to check.
// Spec: docs/superpowers/specs/2026-09-21-live-system-diagram-design.md

const DIR = __dirname;
const JSON_PATH = join(DIR, "system-architecture.json");
const HTML_PATH = join(DIR, "system-architecture.html");

interface Spec {
  meta: { title: string; quality_profile?: string; views?: { note: string }[] };
  components: { id: string; label: string; sublabel?: string }[];
  connections: { from: string; to: string; label?: string }[];
}

const spec: Spec = JSON.parse(readFileSync(JSON_PATH, "utf8"));

function strings(o: unknown, out: string[] = []): string[] {
  if (typeof o === "string") out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => strings(v, out));
  else if (o && typeof o === "object") Object.values(o).forEach((v) => strings(v, out));
  return out;
}

describe("system diagram source", () => {
  it("is a showcase-quality archify architecture spec", () => {
    expect((spec as { diagram_type?: string }).diagram_type).toBe("architecture");
    expect(spec.meta.quality_profile).toBe("showcase");
    for (const v of spec.meta.views ?? []) expect(v.note.length).toBeLessThanOrEqual(140);
  });

  it("every connection joins two declared components", () => {
    const ids = new Set(spec.components.map((c) => c.id));
    for (const c of spec.connections) {
      expect(ids.has(c.from), `unknown component ${c.from}`).toBe(true);
      expect(ids.has(c.to), `unknown component ${c.to}`).toBe(true);
    }
  });

  it("names no real person: no email address or phone number in any string", () => {
    for (const s of strings(spec)) {
      expect(s, s).not.toMatch(/@/);
      expect(s, s).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
    }
  });
});

describe("system diagram render", () => {
  it("exists and reflects the current source", () => {
    expect(existsSync(HTML_PATH), "run npm run diagram:render").toBe(true);
    const html = readFileSync(HTML_PATH, "utf8");
    expect(html).toContain(spec.meta.title);
    for (const c of spec.components) {
      expect(html, `component "${c.label}" missing from HTML: re-render`).toContain(c.label);
      if (c.sublabel) expect(html, `sublabel "${c.sublabel}" missing: re-render`).toContain(c.sublabel);
    }
    for (const c of spec.connections) {
      if (c.label) expect(html, `relationship label "${c.label}" missing: re-render`).toContain(c.label);
    }
  });
});
