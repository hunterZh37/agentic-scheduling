-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "reminderOffsetsMinutes" INTEGER[] DEFAULT ARRAY[1440, 60]::INTEGER[];
