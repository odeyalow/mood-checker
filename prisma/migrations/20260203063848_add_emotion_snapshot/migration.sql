/*
  Warnings:

  - You are about to alter the column `recognitions` on the `EmotionSnapshot` table. The data in that column could be lost. The data in that column will be cast from `Unsupported("json")` to `Json`.
  - You are about to alter the column `students` on the `EmotionSnapshot` table. The data in that column could be lost. The data in that column will be cast from `Unsupported("json")` to `Json`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmotionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucketStart" DATETIME NOT NULL,
    "totalStudents" INTEGER NOT NULL,
    "positiveCount" INTEGER NOT NULL,
    "neutralCount" INTEGER NOT NULL,
    "negativeCount" INTEGER NOT NULL,
    "students" JSONB NOT NULL,
    "recognitions" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_EmotionSnapshot" ("bucketStart", "createdAt", "id", "negativeCount", "neutralCount", "positiveCount", "recognitions", "students", "totalStudents") SELECT "bucketStart", "createdAt", "id", "negativeCount", "neutralCount", "positiveCount", "recognitions", "students", "totalStudents" FROM "EmotionSnapshot";
DROP TABLE "EmotionSnapshot";
ALTER TABLE "new_EmotionSnapshot" RENAME TO "EmotionSnapshot";
CREATE UNIQUE INDEX "EmotionSnapshot_bucketStart_key" ON "EmotionSnapshot"("bucketStart");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
