-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "visible" BOOLEAN NOT NULL DEFAULT true;
