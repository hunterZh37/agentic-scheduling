-- DropIndex
DROP INDEX "Reminder_sentAt_fireAt_idx";

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Reminder_sentAt_failedAt_fireAt_idx" ON "Reminder"("sentAt", "failedAt", "fireAt");

-- Double-book guard: at most one CONFIRMED booking per destination account at a
-- given start time. Partial (status = 'confirmed') so a cancelled slot can be
-- rebooked. Enforced at the DB layer to close the read-validate-write TOCTOU
-- race between concurrent booking requests. Not expressible in the Prisma
-- schema (partial unique index), so it lives in raw SQL here.
CREATE UNIQUE INDEX "Booking_destination_start_confirmed_key"
  ON "Booking"("destinationAccountId", "startTime")
  WHERE "status" = 'confirmed';
