-- Carry-forward: unfinished actionables are duplicated onto the next day. Each
-- copy records the todo it was cloned from in "rolledFromId". The UNIQUE index is
-- the idempotency guard: a given source todo can be carried at most once, so a
-- re-run of the cron (or a double load) can never create a second copy.
--
-- Postgres allows many NULLs under a unique index, so ordinary (non-carried)
-- todos are unaffected. Additive and non-breaking: no existing row changes.

-- AlterTable
ALTER TABLE "Todo" ADD COLUMN "rolledFromId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Todo_rolledFromId_key" ON "Todo"("rolledFromId");
