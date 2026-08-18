-- CreateTable
CREATE TABLE "BlockActionable" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockActionable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockActionable_blockId_idx" ON "BlockActionable"("blockId");

-- AddForeignKey
ALTER TABLE "BlockActionable" ADD CONSTRAINT "BlockActionable_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "PersonalBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
