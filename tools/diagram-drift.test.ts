import { describe, it, expect } from "vitest";
import { drift, DIAGRAM_JSON } from "./diagram-drift.mjs";

const A = (path: string) => ({ status: "A", path });
const M = (path: string) => ({ status: "M", path });
const D = (path: string) => ({ status: "D", path });
const R = (from: string, path: string) => ({ status: "R100", path, from });

describe("drift", () => {
  it("a new API route drifts", () => {
    const r = drift([A("src/app/api/foo/route.ts")]);
    expect(r.touched).toBe(false);
    expect(r.reasons).toEqual(["added src/app/api/foo/route.ts"]);
  });

  it("editing an existing lib file does not drift; adding, removing or renaming one does", () => {
    expect(drift([M("src/lib/booking/service.ts")]).reasons).toEqual([]);
    expect(drift([A("src/lib/newthing/index.ts")]).reasons).toHaveLength(1);
    expect(drift([D("src/lib/sms/inbound.ts")]).reasons).toHaveLength(1);
    expect(drift([R("src/lib/a.ts", "src/lib/b.ts")]).reasons).toEqual([
      "renamed src/lib/a.ts -> src/lib/b.ts",
    ]);
  });

  it("any edit to vercel.json or the proxy drifts", () => {
    expect(drift([M("vercel.json")]).reasons).toEqual(["edited vercel.json"]);
    expect(drift([M("src/proxy.ts")]).reasons).toEqual(["edited src/proxy.ts"]);
  });

  it("a new page drifts, a page edit does not", () => {
    expect(drift([A("src/app/stats/page.tsx")]).reasons).toHaveLength(1);
    expect(drift([M("src/app/book/page.tsx")]).reasons).toEqual([]);
  });

  it("tests, docs, styles, e2e, evals and the website never drift", () => {
    const r = drift([
      A("src/app/api/foo/route.test.ts"),
      A("src/lib/x/y.test.ts"),
      M("docs/REGRESSIONS.md"),
      A("src/components/a/A.module.css"),
      A("e2e/z.spec.ts"),
      A("evals/q.json"),
      A("website/index.html"),
      A("public/icons/x.png"),
      A("src/lib/x/__fixtures__/f.json"),
    ]);
    expect(r.reasons).toEqual([]);
  });

  it("is satisfied when the diagram JSON is part of the change", () => {
    const r = drift([A("src/app/api/foo/route.ts"), M(DIAGRAM_JSON)]);
    expect(r.touched).toBe(true);
    expect(r.reasons).toHaveLength(1);
  });

  it("deleting the diagram source is drift, not compliance", () => {
    const r = drift([A("src/app/api/foo/route.ts"), D(DIAGRAM_JSON)]);
    expect(r.touched).toBe(false);
    expect(r.reasons).toEqual(["added src/app/api/foo/route.ts", `removed ${DIAGRAM_JSON}`]);
    expect(drift([D(DIAGRAM_JSON)]).reasons).toEqual([`removed ${DIAGRAM_JSON}`]);
  });

  it("a copied structural file drifts like a rename", () => {
    expect(drift([{ status: "C100", from: "src/lib/a.ts", path: "src/lib/b.ts" }]).reasons).toEqual([
      "copied src/lib/a.ts -> src/lib/b.ts",
    ]);
  });

  it("a dependency added or removed in package.json drifts; a version bump does not", () => {
    const before = JSON.stringify({ dependencies: { next: "1", luxon: "1" } });
    const bump = JSON.stringify({ dependencies: { next: "2", luxon: "1" } });
    const add = JSON.stringify({ dependencies: { next: "1", luxon: "1", stripe: "1" } });
    const drop = JSON.stringify({ dependencies: { next: "1" } });
    expect(drift([M("package.json")], { manifests: { before, after: bump } }).reasons).toEqual([]);
    expect(drift([M("package.json")], { manifests: { before, after: add } }).reasons).toEqual([
      "package.json dependencies changed: +stripe",
    ]);
    expect(drift([M("package.json")], { manifests: { before, after: drop } }).reasons).toEqual([
      "package.json dependencies changed: -luxon",
    ]);
  });

  it("an unreadable package.json is reported, not ignored", () => {
    expect(drift([M("package.json")], { manifests: { before: "{", after: "{" } }).reasons).toEqual([
      "package.json changed (could not compare dependencies)",
    ]);
  });

  it("a Prisma model added or removed drifts; a column does not", () => {
    const before = "model A {\n id String @id\n}\n";
    const column = "model A {\n id String @id\n x Int\n}\n";
    const model = before + "model B {\n id String @id\n}\n";
    expect(drift([M("prisma/schema.prisma")], { schema: { before, after: column } }).reasons).toEqual([]);
    expect(drift([M("prisma/schema.prisma")], { schema: { before, after: model } }).reasons).toEqual([
      "prisma models changed: +B",
    ]);
  });

  it("the extension and scripts are structural", () => {
    expect(drift([A("calendly-extension/popup.js")]).reasons).toHaveLength(1);
    expect(drift([A("scripts/new-cron.mjs")]).reasons).toHaveLength(1);
    expect(drift([M("scripts/smoke.mjs")]).reasons).toEqual([]);
  });
});
