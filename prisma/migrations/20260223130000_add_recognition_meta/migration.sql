-- Add metadata columns for recognition quality diagnostics.
ALTER TABLE "Recognition" ADD COLUMN "cameraId" TEXT;
ALTER TABLE "Recognition" ADD COLUMN "distance" REAL;
ALTER TABLE "Recognition" ADD COLUMN "emotionConfidence" REAL;
ALTER TABLE "Recognition" ADD COLUMN "workerZoom" REAL;
ALTER TABLE "Recognition" ADD COLUMN "frameWidth" INTEGER;
ALTER TABLE "Recognition" ADD COLUMN "frameHeight" INTEGER;

CREATE INDEX "Recognition_detectedAt_idx" ON "Recognition"("detectedAt");
CREATE INDEX "Recognition_cameraId_detectedAt_idx" ON "Recognition"("cameraId", "detectedAt");
