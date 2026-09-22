# Live system diagram

Date: 2026-09-21
Status: approved in chat (repo: this one; drift refusal only, no background
agent; ported from messaging-agent as it stood on 2026-09-21)

## Goal

One picture of this system that is always current: an archify architecture
diagram whose source lives in the repo, which re-renders on every change,
and which a commit cannot quietly leave behind.

Origin: the same design in `~/Desktop/messaging-agent` (its `.githooks` and
`tools/diagram-*.mjs`, uncommitted there on 2026-09-21). Ported, not shared:
the two repos have different source trees, so the drift rules differ.

## What "real-time" means here

No tool can infer a diagram from a diff. The diagram is a hand-maintained
JSON file. What is automatic:

1. **Noticing**: a commit that changes the system's shape without touching
   the JSON is detected.
2. **Insisting**: inside Claude Code that commit is refused until the JSON
   is updated (or the author states they looked and nothing changed).
3. **Rendering**: whenever the JSON changes, the HTML is re-rendered and
   committed alongside it, and an open live view reloads.

Out of scope, by decision: a background agent that edits the JSON for commits
made outside Claude Code. Nearly every commit here goes through Claude Code;
drift from elsewhere is logged, not repaired.

## Components

### 1. Source and artifact: `docs/diagrams/`

- `system-architecture.json`: archify `architecture` spec, `schema_version: 1`,
  `quality_profile: "showcase"`, curated `meta.views` (at most five chapters).
  Authored from repository evidence, no real person's name, email or phone.
- `system-architecture.html`: rendered by
  `node ~/.claude/skills/archify/bin/archify.mjs deliver architecture <json> <html> --quality showcase --json`.
  Committed, so GitHub and a fresh clone show the picture without archify.

Initial content, from the inventory:

| Boundary | Components |
|---|---|
| Visitor | booking page `/book`, `/book/<team>`, `/manage/<id>`, public agent chat, Calendly extension |
| Owner | dashboard `/`, `/assistant`, `/cohost`, phone via WhatsApp/SMS, Slack |
| Vercel (Next 16 app) | `src/proxy.ts` auth gate; public APIs (availability, public bookings, agent public/negotiate/requester, MCP public tier); private APIs (schedule, events, todos, blocks, bookings, settings, MCP private tier); availability engine (`src/lib/availability`, `src/lib/calendar/aggregate`); booking service; agents (`src/lib/agent`); notify pipeline (`src/lib/notify`); crons: reminders (5 min), morning-brief (hourly), carryforward (daily), monitor (4 h), reputation (daily) |
| Data | Neon Postgres via Prisma |
| External | Google Calendar API, Microsoft Graph, Google OAuth (sign-in), Anthropic API, Twilio (WhatsApp + SMS), Resend, OpenAI (voice-note transcription), Slack Events API, Web Push (VAPID) |

### 2. Drift check: `tools/diagram-drift.mjs`

Plain ESM, no imports, runnable by `node` in a hook and importable by vitest.
Exit 0 = no drift, 1 = drift (reasons on stdout), 2 = could not tell.

Rules for this repo:

- **Structural** (add/remove/rename can redraw): `src/app/api/**`,
  `src/lib/<dir>/` top-level module dirs, `src/app/<route>/page.tsx`,
  `src/proxy.ts`, `calendly-extension/**`, `scripts/**` (non-test).
- **Always** (any edit is architectural): `vercel.json` (crons),
  `src/proxy.ts`, `prisma/schema.prisma` when a `model` line is added or
  removed (a new store-adjacent concept), `package.json` when
  `dependencies` gain or lose a package.
- **Never**: tests, fixtures, `docs/**`, `website/**`, styles, images,
  markdown, `e2e/**`, `evals/**`.
- `touched`: `docs/diagrams/system-architecture.json` is in the change.

Drift = some structural or always rule fired AND not touched.

CLI: `--staged` (index vs HEAD, for pre-commit) and `--commit <rev>`.

### 3. Hooks: `.githooks/` (already the repo's hooksPath)

- `pre-commit` (new): only when `CLAUDECODE=1`. Runs the drift check on the
  index; on drift, prints the reasons and the exact render command and
  exits 1. Escape: `DIAGRAM_UNCHANGED=1 git commit …` ("looked, nothing to
  draw"). `ARCHIFY_HOOK=1` bypasses (the hook's own render commit).
- `post-commit` (new): if HEAD touched the JSON, render; if the HTML
  changed, commit it as `diagram: render <sha>` with `ARCHIFY_HOOK=1` so
  the hooks do not recurse. Log to `.git/archify.log`. If HEAD drifted and
  the commit was made outside Claude Code, append a `drift` line to the log
  and print one line; nothing else (decision: no background agent).
- `pre-push` (existing): unchanged.

### 4. Live view: `tools/diagram-live.mjs`, `npm run diagram`

Serves the HTML on `localhost:4178`, injects a reload snippet, watches
`docs/diagrams/`. A JSON save re-renders with archify and reloads the tab; a
commit or pull that rewrites the HTML reloads it too. `--no-open` skips the
browser.

### 5. Instructions: `AGENTS.md`

A section telling every session: when a change adds, removes, renames or
re-wires a component, boundary, data store, external service or runtime
process, or changes how data flows, edit the JSON in the same change and
render it. State the escape hatch and that the hook enforces it.

## Guards

- `tools/diagram-drift.test.ts` (vitest): each rule class, the `touched`
  short-circuit, rename handling, the `package.json` dependency diff,
  the prisma `model` add/remove rule, and that a docs-only or test-only
  change never drifts.
- `docs/diagrams/diagram.test.ts` (vitest): the committed JSON validates
  with archify at showcase quality (skips with a clear message if archify is
  not installed), and the committed HTML is not older than the JSON.
- Manual, once: a Claude Code commit touching `src/app/api/` without the
  JSON is refused; with `DIAGRAM_UNCHANGED=1` it passes; a JSON edit commit
  is followed by a `diagram: render` commit; `npm run diagram` reloads on
  save.

## Files

- `docs/diagrams/system-architecture.json`, `.html` (new)
- `docs/diagrams/diagram.test.ts` (new)
- `tools/diagram-drift.mjs`, `tools/diagram-drift.test.ts`, `tools/diagram-live.mjs` (new)
- `.githooks/pre-commit`, `.githooks/post-commit` (new)
- `package.json`: `diagram` script
- `AGENTS.md`: diagram section
- `vitest.config.mts`: include `tools/**/*.test.ts` and `docs/diagrams/*.test.ts` if not already matched
