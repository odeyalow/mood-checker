-- Per-identity descriptor gallery for more robust face matching.
CREATE TABLE "FaceDescriptor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "faceIdentityId" TEXT NOT NULL,
    "descriptor" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FaceDescriptor_faceIdentityId_fkey" FOREIGN KEY ("faceIdentityId") REFERENCES "FaceIdentity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "FaceDescriptor_faceIdentityId_idx" ON "FaceDescriptor"("faceIdentityId");
