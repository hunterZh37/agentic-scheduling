# Actionable to-do lists (replacing follow-ups)

Date: 2026-09-24
Status: decisions approved in chat

## Goal

An actionable can carry a to-do list: a checklist of sub-items. The agenda row
and the detail panel show progress ("1 of 3"). Alex recognises a list in an
instruction and creates one actionable with the items attached. Follow-ups
(checklists attached to calendar events) are removed; existing ones are
converted so nothing already written is lost.

## Decisions (owner, 2026-09-24)

1. Lists attach to **actionables only**. Events and bookings carry no list.
2. Existing follow-ups are **converted**: one new untimed actionable per event
   occurrence, on that occurrence's day, with the follow-ups as its items.
   The `EventFollowup` table is then dropped.
3. Progress **replaces the "Actionable" tag** on the agenda row when a list
   exists, and shows in the detail panel header. Clicking either opens the card.
4. Finishing the last item does **not** auto-complete the actionable.
5. Carry-forward **copies the whole list with done states**.

## Data

```prisma
model TodoItem {
  id        String   @id @default(cuid())
  todoId    String
  todo      Todo     @relation(fields: [todoId], references: [id], onDelete: Cascade)
  title     String
  done      Boolean  @default(false)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  @@index([todoId, sortOrder])
}
```

`Todo` gains `items TodoItem[]`. Deleting an actionable deletes its items.

Migration `add_todo_items_drop_followups`, in one SQL file, in this order:
1. Create `TodoItem`.
2. For each distinct `EventFollowup.eventKey` (`event:<id>:<startISO>`):
   insert a `Todo` titled `Follow-ups from <weekday, month day>` (owner-local
   day of `<startISO>`), `date` = that day's key (owner-local midnight as UTC),
   untimed, `done` = every follow-up done; then insert its follow-ups as
   `TodoItem` rows in `sortOrder, createdAt` order. The title cannot carry the
   event's name: the database never stored it. The owner renames.
   Timezone: the migration cannot read `OWNER_TIMEZONE`; it uses
   `America/Los_Angeles`, the owner's zone, via Postgres `AT TIME ZONE`.
3. Delete `Nudge` rows with `eventKind = 'followup'`.
4. Drop `EventFollowup`.

## API

- `GET /api/todos?date=` (existing): each todo now includes
  `items: {id,title,done,sortOrder}[]` and `progress: {done, total}`.
- `POST /api/todos` (existing): optional `items: string[]`.
- `PATCH /api/todos/[id]` (existing): optional `items` as a full replacement
  list of `{id?, title, done}`, in order. Missing ids are created, absent ids
  are deleted, present ids are updated. One round trip for the editor.
- `POST /api/todos/[id]/items` `{title}` → item. Quick-add from the panel.
- `PATCH /api/todos/[id]/items/[itemId]` `{title?, done?}`.
- `DELETE /api/todos/[id]/items/[itemId]`.
- Removed: `/api/followups`, `/api/followups/[id]`.
- `src/proxy.ts` comment updated; no allowlist change (all private).

## UI

- **Agenda row** (`BlocksPane.tsx`, timed and untimed rows): when
  `items.length > 0`, the tag reads `1 of 3` (`done of total`) in the same
  pill style; otherwise `Actionable` as today. The pill is part of the row's
  existing click target (opens the card).
- **Detail panel** (`EventModal.tsx`, actionable only): header shows `1 of 3`
  beside the title when a list exists. Below the existing rows, a section
  "To-do list": each item is a check row (click toggles done, strike-through
  when done), an inline delete, and a quick-add input, the same interaction
  the follow-ups section had. Reordering is out of scope.
- **Editor** (edit mode): items editable as text rows with add/remove; saved
  with the actionable through PATCH `items`.
- `AgendaFollowups.tsx`, `EventFollowups.tsx`, `src/lib/followups/` removed.
  The `followup` reminder kind removed from `ReminderControl` and the nudge
  service. `CalendarView.tsx` follow-up plumbing removed.
- `CalendarItem` gains `items?: TodoItem[]` for actionables.

## Alex

- Tools: `add_todo_items(actionableId, titles[])`,
  `set_todo_item_done(actionableId, itemId, done)`,
  `remove_todo_item(actionableId, itemId)`. `create_actionable` gains optional
  `items: string[]`. `list_actionables` returns items and progress.
- Removed: `list_followups`, `add_followup`, `complete_followup`,
  `delete_followup`, and their instruction paragraph.
- Instruction paragraph (private agent): when the owner's request names one
  task with several parts, or lists steps ("for the Keith meeting: send the
  links, remove Stephanie from Salesforce"), create ONE actionable titled for
  the task with the parts as `items`, not one actionable per line. When the
  owner says "done with X" and X matches an item, mark the item, not the
  actionable. Confirm the wording back as a list. Items render as markdown;
  write links as `[label](url)`.
- MCP private tools: mirror the same additions and removals if the MCP layer
  exposes actionables (check `src/lib/mcp`).

## Carry-forward

`carriedTodoData` unchanged; `carryForwardTodos` copies items
(title, done, sortOrder) onto the new row. `recurring.ts` templates have no
items; a seeded actionable starts with an empty list (out of scope).

## Guards

- `src/lib/todos/items.test.ts`: the PATCH replacement-list diff (create,
  update, delete, order) as a pure function; `progress()`.
- `src/lib/todos/carryForward.test.ts`: items copied with done states.
- `src/lib/agent/todoItemsTools.test.ts`: tools validate ids and titles; a
  request with several parts becomes one actionable (eval fixture under
  `evals/`, matching the existing eval style).
- `scripts/mobile-audit.mjs`: the actionable detail overlay already opens;
  the list renders inside it, so the tap-floor and overflow checks cover it.
  Add the quick-add input to the overlay scenario.
- Migration: `prisma/migrations/.../migration.sql` reviewed by hand and run
  against the local database seeded with two follow-ups before push; the
  resulting actionable and items asserted with a script. Marked in the ledger
  as the one manual step.
- Ledger: no bug row (feature), but a note under "Blocks pane" that follow-ups
  were replaced on 2026-09-24 and where the converted items went.

## Out of scope

Reordering items by drag; lists on recurring templates; lists on events or
bookings; per-item reminders.
