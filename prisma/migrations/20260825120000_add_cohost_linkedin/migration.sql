-- Optional LinkedIn URL per co-host, linked from their name on the joint
-- booking page. Additive and nullable; existing rows get NULL.
ALTER TABLE "CoHost" ADD COLUMN "linkedin" TEXT;
