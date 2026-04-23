#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.worker");

const cameraSettings = {
  "cam-01": {
    frameOffsetY: 0,
    confirmFrames: 1,
    minConfirmScore: 0.12,
    filterMinScore: 0.09,
    personMinScore: 0.16,
    personMinSidePx: 20,
    personMinStreak: 1,
    matchThreshold: 0.56,
    matchMinMargin: 0.04,
    matchMinFaceSidePx: 16,
    matchIntervalMs: 120,
    sessionSnapshotIntervalMs: 500,
    sessionResolveWaitMs: 500,
    sessionMinSamples: 1,
    sessionMinEmotionSamples: 1,
    sessionAbsenceMs: 3300,
    recognitionHoldMs: 2500,
    newIdConfirmFrames: 1,
    newIdMinScore: 0.14,
    newIdMinFaceSidePx: 20,
    newIdEmptyMinScore: 0.16,
    newIdEmptyMinFaceSidePx: 20,
    newIdMinSharpness: 9,
    newIdEmptyMinSharpness: 11,
  },
};

const updates = new Map([
  ["WORKER_FRAME_TIMEOUT_MS", "3000"],
  ["WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", "5200"],
  ["WORKER_FRAME_ABORT_RETRY_WIDTH", "1280"],
  ["WORKER_FRAME_ABORT_RETRY_HEIGHT", "720"],
  ["WORKER_FRAME_ABORT_RETRY_QUALITY", "82"],
  ["WORKER_CAMERA_SOURCES", "cam-01=cam01_main"],
  ["WORKER_PARALLEL_CAMERAS", "1"],
  ["WORKER_CAMERA_ZOOMS", "cam-01=1"],
  ["WORKER_DB_COOLDOWN_MS", "3000"],
  ["WORKER_DB_REENTRY_GAP_MS", "1200"],
  ["WORKER_EMOTION_ALLOW_LOW_CONFIDENCE_LABEL", "true"],
  ["WORKER_DB_ALLOW_MOOD_FALLBACK", "true"],
  ["WORKER_DB_FALLBACK_MOOD", "neutral"],
  ["WORKER_CAMERA_SETTINGS_JSON", JSON.stringify(cameraSettings)],
]);

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
}

function getEnvKey(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  return match ? match[1] : null;
}

function writeLines(filePath, lines) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
  fs.writeFileSync(filePath, body, "utf-8");
}

function applyUpdates(filePath, pairs) {
  const managedKeys = new Set(pairs.keys());
  const lines = readLines(filePath).filter((line) => {
    const key = getEnvKey(line);
    return !key || !managedKeys.has(key);
  });
  const changed = [];

  for (const [key, value] of pairs) {
    const nextLine = `${key}=${value}`;
    lines.push(nextLine);
    changed.push(key);
  }

  writeLines(filePath, lines);
  return changed;
}

const changedKeys = applyUpdates(envFile, updates);
process.stdout.write(`[worker-profile] updated ${envFile}\n`);
process.stdout.write(`[worker-profile] keys: ${changedKeys.join(", ")}\n`);
process.stdout.write("[worker-profile] next: pm2 restart mood-checker-worker --update-env\n");
