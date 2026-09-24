# Actionable To-do Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sub-item checklists on actionables with "1 of 3" progress, Alex creating them from list-shaped requests, and follow-ups removed with their data converted.

**Architecture:** New `TodoItem` rows under `Todo`; a pure `diffItems` reconciler drives the PATCH replacement list; the agenda row, detail panel, agent tools and MCP read `items` and `progress` from the same todo serializer; one SQL migration converts follow-ups and drops their table.

**Tech Stack:** Next 16 App Router, Prisma 6 on Postgres, React 19, Anthropic tool-calling agent, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-actionable-todo-lists-design.md`

## Global Constraints

- Lists on actionables only; no auto-complete of the parent; carry-forward copies items with done states.
- No emoji in the UI; inline SVG icons. No em dashes in copy.
- Every busy-time path untouched (items never affect availability).
- Diagram: `src/lib/todos/` gains files and `src/app/api/todos/[id]/items/**` is new; the diagram already shows "Private APIs: schedule, todos, MCP" so update the JSON sublabel only if a new component appears (it does not); commit with `DIAGRAM_UNCHANGED=1` after checking.
- `npm run verify` and `/verify` before the final commit.

---

### Task 1: Schema, migration, serializer

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260924120000_add_todo_items_drop_followups/migration.sql`, `src/lib/todos/items.ts`, `src/lib/todos/items.test.ts`

**Produces:** `progress(items) -> {done,total}`; `diffItems(existing, incoming) -> {create, update, delete}`; `todoSelect` Prisma select including items; `serializeTodo(row)`.

- [ ] Test `diffItems`: new titles create; existing ids update title/done/sortOrder by position; ids not in incoming delete; order preserved.
- [ ] Test `progress`.
- [ ] Add `TodoItem` model + `Todo.items`; write the migration SQL by hand (create table, convert follow-ups per spec using `America/Los_Angeles`, delete followup nudges, drop `EventFollowup`).
- [ ] Apply to the local DB (`DIRECT_URL` inline), seed two follow-ups first and assert the converted actionable via a scratch script.
- [ ] `prisma generate`; tests pass.

### Task 2: API

**Files:** `src/app/api/todos/route.ts`, `src/app/api/todos/[id]/route.ts`, `src/app/api/todos/[id]/items/route.ts`, `src/app/api/todos/[id]/items/[itemId]/route.ts`; delete `src/app/api/followups/**`.

- [ ] GET returns `items` and `progress`; POST accepts `items: string[]`; PATCH accepts `items` replacement list via `diffItems` in a transaction.
- [ ] Item routes: POST (add), PATCH (title/done), DELETE. Validate: title 1..200 chars, item belongs to todo.
- [ ] Existing route tests updated; new tests for the item routes' validation.

### Task 3: Carry-forward

**Files:** `src/lib/todos/carryForward.ts`, `.test.ts`

- [ ] Test: a source with items produces a copy whose items match (title, done, sortOrder).
- [ ] Copy items in `carryForwardTodos` via nested create.

### Task 4: UI

**Files:** `src/components/calendar/types.ts`, `src/components/blocks/detailItem.ts`, `src/components/blocks/BlocksPane.tsx`, `src/components/blocks/BlocksPane.module.css`, `src/components/calendar/EventModal.tsx`, `src/components/calendar/EventModal.module.css`, new `src/components/calendar/TodoItems.tsx`; delete `AgendaFollowups.tsx`, `EventFollowups.tsx`, `src/lib/followups/`; `ReminderControl.tsx`, `src/lib/nudge/service.ts`, `CalendarView.tsx` follow-up plumbing removed.

- [ ] `CalendarItem.items?`; agenda rows carry items; tag shows `d of t` when items exist (pure `progressLabel` in items.ts, tested).
- [ ] `TodoItems` component: check row, delete, quick-add; used in the panel's view mode; editor rows in edit mode saved via PATCH `items`.
- [ ] Panel header shows the count for actionables with items.
- [ ] Remove follow-up UI and reminder kind.
- [ ] Mobile audit scenario: open an actionable with items; assert the quick-add input meets the 44px/16px rules.

### Task 5: Alex and MCP

**Files:** `src/lib/agent/tools.ts`, `src/lib/agent/run.ts`, `src/lib/agent/todoItemsTools.test.ts`, `src/lib/mcp/tools.ts`, `evals/` fixture.

- [ ] Remove the four follow-up tools and their prompt paragraph.
- [ ] `create_actionable.items`, `add_todo_items`, `set_todo_item_done`, `remove_todo_item`; `list_actionables` returns items+progress.
- [ ] Prompt paragraph per spec.
- [ ] MCP `create_actionable.items`.
- [ ] Tests for validation; eval fixture for the list-shaped request.

### Task 6: Docs, ledger, verify

- [ ] Ledger note under "Blocks pane"; README mention of follow-ups updated if any.
- [ ] `npm run verify`, `/verify`, commit.
