-- Purely cosmetic: swap the hardcoded personal-identity column defaults for
-- generic placeholders now that this app is a self-hostable template. These
-- defaults are effectively dead in practice (both prisma/seed.ts and the
-- settings/blocks/nudge APIs always set these fields explicitly on insert),
-- so this changes no existing row and only affects any future INSERT that
-- omits the column outright.

-- AlterTable
ALTER TABLE "PersonalBlock" ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';

-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "destinationEmail" SET DEFAULT 'owner@example.com';

-- AlterTable
ALTER TABLE "Nudge" ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';
