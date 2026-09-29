-- Actionables gain free-text notes (context such as a back-link), distinct
-- from their to-do items (owner, 2026-09-24).
ALTER TABLE "Todo" ADD COLUMN "notes" TEXT;
