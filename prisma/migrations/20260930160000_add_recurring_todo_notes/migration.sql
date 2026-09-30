-- Recurring actionable templates gain notes; every seeded occurrence inherits
-- them (owner, 2026-09-30).
ALTER TABLE "RecurringTodo" ADD COLUMN "notes" TEXT;
