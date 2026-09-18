-- Quality (0..1) of the frame the primary vector came from, so a later and
-- better frame of the same person can replace the enrolment frame instead of
-- only nudging it. Nullable: existing identities count as "worse than anything
-- measured" and are upgraded by their next good sighting.
ALTER TABLE "FaceIdentity" ADD COLUMN "primaryQuality" REAL;
