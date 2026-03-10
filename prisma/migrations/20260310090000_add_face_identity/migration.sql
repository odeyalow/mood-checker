-- Face identity registry for auto-assigned short IDs.
CREATE TABLE "FaceIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shortId" TEXT NOT NULL,
    "descriptor" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Recognition" ADD COLUMN "snapshotUrl" TEXT;
ALTER TABLE "Recognition" ADD COLUMN "faceIdentityId" TEXT REFERENCES "FaceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "FaceIdentity_shortId_key" ON "FaceIdentity"("shortId");
CREATE INDEX "FaceIdentity_createdAt_idx" ON "FaceIdentity"("createdAt");
CREATE INDEX "Recognition_faceIdentityId_detectedAt_idx" ON "Recognition"("faceIdentityId", "detectedAt");
