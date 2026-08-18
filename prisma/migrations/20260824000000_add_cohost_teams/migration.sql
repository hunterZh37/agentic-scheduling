-- Co-host + team foundation. Additive and non-breaking: existing Account and
-- PersonalBlock rows get a NULL coHostId, which means "the owner's" — so the
-- single-owner app is unchanged. New tables are empty until the team feature
-- is used.

-- CreateTable
CREATE TABLE "CoHost" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationOptionsMinutes" INTEGER[] DEFAULT ARRAY[30]::INTEGER[],
    "eventTitle" TEXT NOT NULL DEFAULT 'Meeting',
    "videoLink" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "coHostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "coHostId" TEXT;

-- AlterTable
ALTER TABLE "PersonalBlock" ADD COLUMN "coHostId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CoHost_email_key" ON "CoHost"("email");
CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");
CREATE UNIQUE INDEX "TeamMember_teamId_coHostId_key" ON "TeamMember"("teamId", "coHostId");
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");
CREATE INDEX "Account_coHostId_idx" ON "Account"("coHostId");
CREATE INDEX "PersonalBlock_coHostId_idx" ON "PersonalBlock"("coHostId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_coHostId_fkey" FOREIGN KEY ("coHostId") REFERENCES "CoHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalBlock" ADD CONSTRAINT "PersonalBlock_coHostId_fkey" FOREIGN KEY ("coHostId") REFERENCES "CoHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_coHostId_fkey" FOREIGN KEY ("coHostId") REFERENCES "CoHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
