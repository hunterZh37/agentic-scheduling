-- Actionable to-do lists replace event follow-ups (owner decision, 2026-09-24).
-- Spec: docs/superpowers/specs/2026-09-24-actionable-todo-lists-design.md

-- 1. The new table.
CREATE TABLE "TodoItem" (
    "id" TEXT NOT NULL,
    "todoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TodoItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TodoItem_todoId_sortOrder_idx" ON "TodoItem"("todoId", "sortOrder");
ALTER TABLE "TodoItem" ADD CONSTRAINT "TodoItem_todoId_fkey"
    FOREIGN KEY ("todoId") REFERENCES "Todo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Convert existing follow-ups. An eventKey is "event:<providerId>:<startISO>";
--    the event's title was never stored, so the actionable is named after the
--    day and the owner renames it. The owner's zone is America/Los_Angeles;
--    Todo.date is that zone's midnight expressed in UTC (the app's day key).
-- A key that does not parse (the old POST route never validated the format)
-- falls back to the day the first follow-up was written, so no row can ever
-- abort the deploy with a NULL day.
CREATE TEMP TABLE followup_groups AS
SELECT
    "eventKey",
    md5("eventKey") AS todo_id,
    COALESCE(
        CASE
            WHEN "eventKey" ~ '^event:[^:]+:\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$'
            THEN (substring("eventKey" from '^event:[^:]+:(.+)$'))::timestamptz
        END,
        min("createdAt")
    ) AS start_at
FROM "EventFollowup"
GROUP BY "eventKey";

INSERT INTO "Todo" ("id", "title", "done", "date", "sortOrder", "createdAt")
SELECT
    g.todo_id,
    'Follow-ups from ' || to_char((g.start_at AT TIME ZONE 'America/Los_Angeles'), 'FMDay, FMMonth FMDD'),
    NOT EXISTS (SELECT 1 FROM "EventFollowup" f WHERE f."eventKey" = g."eventKey" AND f."done" = false),
    (date_trunc('day', g.start_at AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'),
    0,
    CURRENT_TIMESTAMP
FROM followup_groups g;

INSERT INTO "TodoItem" ("id", "todoId", "title", "done", "sortOrder", "createdAt")
SELECT
    f."id",
    g.todo_id,
    f."title",
    f."done",
    row_number() OVER (PARTITION BY f."eventKey" ORDER BY f."sortOrder", f."createdAt") - 1,
    f."createdAt"
FROM "EventFollowup" f
JOIN followup_groups g ON g."eventKey" = f."eventKey";

DROP TABLE followup_groups;

-- 3. Reminders that pointed at a follow-up have nothing to point at.
DELETE FROM "Nudge" WHERE "eventKind" = 'followup';

-- 4. Gone.
DROP TABLE "EventFollowup";
