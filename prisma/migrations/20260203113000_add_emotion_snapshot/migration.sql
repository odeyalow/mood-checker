CREATE TABLE "EmotionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucketStart" DATETIME NOT NULL,
    "totalStudents" INTEGER NOT NULL,
    "positiveCount" INTEGER NOT NULL,
    "neutralCount" INTEGER NOT NULL,
    "negativeCount" INTEGER NOT NULL,
    "students" JSON NOT NULL,
    "recognitions" JSON NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "EmotionSnapshot_bucketStart_key" ON "EmotionSnapshot"("bucketStart");
