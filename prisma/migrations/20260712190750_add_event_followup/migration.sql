-- CreateTable
CREATE TABLE "EventFollowup" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventFollowup_eventKey_idx" ON "EventFollowup"("eventKey");
