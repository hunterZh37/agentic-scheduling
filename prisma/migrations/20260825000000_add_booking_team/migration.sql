-- Link a booking to the joint team-link it came through. Additive and
-- non-breaking: existing bookings get NULL (an ordinary single-owner booking).
-- ON DELETE SET NULL so removing a team keeps its bookings, just unlinked.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "teamId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_teamId_idx" ON "Booking"("teamId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
