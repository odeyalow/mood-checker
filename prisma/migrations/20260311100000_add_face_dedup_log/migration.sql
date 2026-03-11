-- CreateTable
CREATE TABLE "FaceDedupLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceFaceId" TEXT,
    "sourceShortId" TEXT,
    "sourceSnapshotUrl" TEXT,
    "targetFaceId" TEXT,
    "targetShortId" TEXT,
    "targetSnapshotUrl" TEXT,
    "distance" REAL,
    "threshold" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "FaceDedupLog_createdAt_idx" ON "FaceDedupLog"("createdAt");
