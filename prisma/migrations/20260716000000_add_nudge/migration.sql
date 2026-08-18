-- CreateTable
CREATE TABLE "Nudge" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "recurrenceRule" TEXT,
    "eventKind" TEXT,
    "eventId" TEXT,
    "eventAccount" TEXT,
    "eventDate" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nudge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Nudge_sentAt_failedAt_fireAt_idx" ON "Nudge"("sentAt", "failedAt", "fireAt");
