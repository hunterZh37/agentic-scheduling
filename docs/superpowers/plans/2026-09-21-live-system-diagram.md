# Live System Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An archify architecture diagram of this repo that re-renders on every change and that a Claude Code commit cannot leave stale.

**Architecture:** A hand-maintained JSON spec under `docs/diagrams/` is the source of truth; a drift rule set (`tools/diagram-drift.mjs`) decides whether a change could redraw it; a pre-commit hook refuses drifting Claude Code commits; a post-commit hook renders and commits the HTML; a small local server reloads the open tab on change.

**Tech Stack:** Node 22 ESM, archify CLI at `~/.claude/skills/archify/bin/archify.mjs`, git hooks in `.githooks/` (already the repo's `core.hooksPath`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-live-system-diagram-design.md`

## Global Constraints

- No background sync agent (decision). Drift outside Claude Code is logged only.
- Never put a real person's name, email or phone number in the diagram.
- No emoji anywhere. No em dashes in prose.
- Hooks must run with plain `node`, before any build: the drift module has no imports.
- Hook-made commits set `ARCHIFY_HOOK=1` so hooks never recurse.
- `npm run verify` must stay green.

---

### Task 1: Drift rules module with tests

**Files:**
- Create: `tools/diagram-drift.mjs`
- Create: `tools/diagram-drift.test.ts`
- Modify: `vitest.config.mts` (include `tools/**/*.test.ts`)

**Interfaces:**
- Produces: `drift(entries, opts) -> { touched: boolean, reasons: string[] }` where `entries` are `{status, path, from?}` rows from `git diff --name-status -M`, and `opts` is `{ manifests?: {before, after}, schema?: {before, after} }` with pre/post file text. `DIAGRAM_JSON = "docs/diagrams/system-architecture.json"`. CLI exit codes 0/1/2.

- [ ] **Step 1: Write the failing test** (`tools/diagram-drift.test.ts`)

```ts
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
    expect(drift([R("src/lib/a.ts", "src/lib/b.ts")]).reasons).toEqual(["renamed src/lib/a.ts -> src/lib/b.ts"]);
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
      A("src/app/api/foo/route.test.ts"), A("src/lib/x/y.test.ts"), M("docs/REGRESSIONS.md"),
      A("src/components/a/A.module.css"), A("e2e/z.spec.ts"), A("evals/q.json"), A("website/index.html"),
      A("public/icons/x.png"),
    ]);
    expect(r.reasons).toEqual([]);
  });
  it("is satisfied when the diagram JSON is part of the change", () => {
    const r = drift([A("src/app/api/foo/route.ts"), M(DIAGRAM_JSON)]);
    expect(r.touched).toBe(true);
    expect(r.reasons).toHaveLength(1);
  });
  it("a dependency added or removed in package.json drifts; a version bump does not", () => {
    const before = JSON.stringify({ dependencies: { next: "1", luxon: "1" } });
    expect(drift([M("package.json")], { manifests: { before, after: JSON.stringify({ dependencies: { next: "2", luxon: "1" } }) } }).reasons).toEqual([]);
    expect(drift([M("package.json")], { manifests: { before, after: JSON.stringify({ dependencies: { next: "1", luxon: "1", stripe: "1" } }) } }).reasons)
      .toEqual(["package.json dependencies changed: +stripe"]);
    expect(drift([M("package.json")], { manifests: { before, after: JSON.stringify({ dependencies: { next: "1" } }) } }).reasons)
      .toEqual(["package.json dependencies changed: -luxon"]);
  });
  it("a Prisma model added or removed drifts; a column does not", () => {
    const before = "model A {\n id String @id\n}\n";
    expect(drift([M("prisma/schema.prisma")], { schema: { before, after: "model A {\n id String @id\n x Int\n}\n" } }).reasons).toEqual([]);
    expect(drift([M("prisma/schema.prisma")], { schema: { before, after: before + "model B {\n id String @id\n}\n" } }).reasons)
      .toEqual(["prisma models changed: +B"]);
  });
  it("the extension and scripts are structural", () => {
    expect(drift([A("calendly-extension/popup.js")]).reasons).toHaveLength(1);
    expect(drift([A("scripts/new-cron.mjs")]).reasons).toHaveLength(1);
    expect(drift([M("scripts/smoke.mjs")]).reasons).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect failure** `npx vitest run tools/diagram-drift.test.ts` fails with "Cannot find module".

- [ ] **Step 3: Implement** `tools/diagram-drift.mjs` (full file in the repo; rules per spec section 2; CLI parses `--staged` via `git diff --cached --name-status -M`, `--commit <rev>` via `git diff-tree -r -M --root --name-status <rev>`, reads before/after of `package.json` and `prisma/schema.prisma` with `git show`).

- [ ] **Step 4: Run tests, expect pass.** Add `"tools/**/*.test.ts"` to vitest `include`.

- [ ] **Step 5: Commit** `git commit -m "diagram: drift rules for this repo"` (with `DIAGRAM_UNCHANGED=1` once the hook exists; before that no hook runs).

### Task 2: Author the diagram

**Files:**
- Create: `docs/diagrams/system-architecture.json`
- Create: `docs/diagrams/system-architecture.html` (rendered)
- Create: `docs/diagrams/diagram.test.ts`

**Interfaces:**
- Produces: the JSON at the path `DIAGRAM_JSON` from Task 1; `npm run diagram:render` script.

- [ ] **Step 1: Read** `~/.claude/skills/archify/schemas/architecture.schema.json`, `schemas/common.schema.json`, one architecture example.
- [ ] **Step 2: Write the candidate JSON** from the spec's component table: boundaries Visitor, Owner, Vercel app, Data, External; at most 12 primary nodes on the main path (booking page -> proxy/API -> availability engine -> calendars; booking service -> destination calendar + notify -> Twilio/Resend); side branches for agents, crons, MCP, Slack, extension. Curated views: "Booking path", "Agents", "Owner channels", "Scheduled jobs".
- [ ] **Step 3: Validate** `node ~/.claude/skills/archify/bin/archify.mjs validate architecture docs/diagrams/system-architecture.json --quality showcase --json` until 9 checks, 0 errors, 0 warnings.
- [ ] **Step 4: Deliver** `... deliver architecture <json> <html> --quality showcase --json`, then `visual-check <html> --json`.
- [ ] **Step 5: Test** `docs/diagrams/diagram.test.ts`: JSON parses, `meta.quality_profile === "showcase"`, no `@` sign or phone-like digit run in any string, HTML mtime >= JSON mtime; add `"docs/diagrams/*.test.ts"` to vitest include. Run: pass.
- [ ] **Step 6: Commit** JSON + HTML + test: `git commit -m "diagram: system architecture"`.

### Task 3: Hooks

**Files:**
- Create: `.githooks/pre-commit`, `.githooks/post-commit` (both `chmod +x`)

- [ ] **Step 1: Write `pre-commit`** per spec 3 (port of messaging-agent's, paths unchanged, `ARCHIFY_HOOK`, `DIAGRAM_UNCHANGED`, `CLAUDECODE` gates).
- [ ] **Step 2: Write `post-commit`** per spec 3: render + `diagram: render <sha>` commit when JSON in HEAD; log drift for non-Claude commits; no agent.
- [ ] **Step 3: Manual test**: in a scratch branch, `CLAUDECODE=1 git commit` with a staged fake `src/app/api/zzz/route.ts` -> refused with reasons; `DIAGRAM_UNCHANGED=1` -> accepted; edit JSON `meta.title` and commit -> a second `diagram: render` commit appears and `.git/archify.log` has a line. Reset the scratch branch.
- [ ] **Step 4: Commit** hooks.

### Task 4: Live view and scripts

**Files:**
- Create: `tools/diagram-live.mjs` (port; paths `docs/diagrams/system-architecture.*`)
- Modify: `package.json` scripts: `"diagram": "node tools/diagram-live.mjs"`, `"diagram:render": "node ~/.claude/skills/archify/bin/archify.mjs deliver architecture docs/diagrams/system-architecture.json docs/diagrams/system-architecture.html --quality showcase --json"` (use `$HOME`).

- [ ] **Step 1: Port the server.** Manual test: `npm run diagram -- --no-open`, `curl localhost:4178` returns the HTML with the reload script; touch the JSON, the log shows a render and a reload broadcast.
- [ ] **Step 2: Commit.**

### Task 5: Instructions

**Files:**
- Modify: `AGENTS.md` (new section "Keep the system diagram current")

- [ ] **Step 1: Add the section** (rule, render command, escape hatch, `npm run diagram`).
- [ ] **Step 2: Commit** with `DIAGRAM_UNCHANGED=1` (docs never drift anyway).
- [ ] **Step 3: `npm run verify`**, then `/verify`.
