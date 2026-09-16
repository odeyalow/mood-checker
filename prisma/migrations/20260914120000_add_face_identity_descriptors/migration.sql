-- Multi-descriptor templates: up to N distinct embeddings per identity so one
-- person can be represented from several angles instead of a single vector.
-- Nullable: existing rows keep working and readers fall back to [descriptor].
ALTER TABLE "FaceIdentity" ADD COLUMN "descriptors" JSONB;
