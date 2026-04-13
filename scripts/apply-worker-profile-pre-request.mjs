#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.worker");

const cameraSettings = {
  "cam-01": {
    confirmFrames: 1,
    minConfirmScore: 0.13,
    filterMinScore: 0.1,
    personMinScore: 0.17,
    personMinSidePx: 20,
    personMinStreak: 1,
    matchThreshold: 0.6,
    matchMinMargin: 0.02,
    matchMinFaceSidePx: 14,
    matchIntervalMs: 130,
    emotionIntervalMs: 220,
    emotionMinConfidence: 0.18,
    emotionLowConfidenceFloor: 0.09,
    sessionSnapshotIntervalMs: 1200,
    sessionResolveWaitMs: 1400,
    sessionMinSamples: 1,
    sessionMinEmotionSamples: 1,
    sessionAbsenceMs: 2300,
    recognitionHoldMs: 2200,
  },
};

const updates = new Map([
  ["WORKER_FRAME_API_BASE", "http://127.0.0.1:1984/api/frame.jpeg?width=960&height=540&quality=82"],
  ["WORKER_FRAME_TIMEOUT_MS", "3000"],
  ["WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", "5200"],
  ["WORKER_FRAME_ABORT_RETRY_WIDTH", "1280"],
  ["WORKER_FRAME_ABORT_RETRY_HEIGHT", "720"],
  ["WORKER_FRAME_ABORT_RETRY_QUALITY", "82"],
  ["WORKER_CAMERA_SOURCES", "cam-01=cam01_main"],
  ["WORKER_PARALLEL_CAMERAS", "1"],
  ["WORKER_DB_REENTRY_GAP_MS", "1400"],
  ["WORKER_DB_COOLDOWN_MS", "3200"],
  ["WORKER_EMOTION_ALLOW_LOW_CONFIDENCE_LABEL", "true"],
  ["WORKER_DB_ALLOW_MOOD_FALLBACK", "true"],
  ["WORKER_DB_FALLBACK_MOOD", "neutral"],
  ["WORKER_CAMERA_ZOOMS", "cam-01=1"],
  ["WORKER_CAMERA_SETTINGS_JSON", JSON.stringify(cameraSettings)],
]);

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
}

function writeLines(filePath, lines) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
  fs.writeFileSync(filePath, body, "utf-8");
}

function findKeyLineIndexes(lines) {
  const result = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const key = match[1];
    if (!result.has(key)) result.set(key, index);
  });
  return result;
}

function applyUpdates(filePath, pairs) {
  const lines = readLines(filePath);
  const keyIndexes = findKeyLineIndexes(lines);
  const changed = [];

  for (const [key, value] of pairs) {
    const nextLine = `${key}=${value}`;
    if (keyIndexes.has(key)) {
      const idx = keyIndexes.get(key);
      if (lines[idx] !== nextLine) {
        lines[idx] = nextLine;
        changed.push(key);
      }
      continue;
    }
    lines.push(nextLine);
    keyIndexes.set(key, lines.length - 1);
    changed.push(key);
  }

  writeLines(filePath, lines);
  return changed;
}

const changedKeys = applyUpdates(envFile, updates);
process.stdout.write(`[worker-profile] updated ${envFile}\n`);
process.stdout.write(`[worker-profile] keys: ${changedKeys.join(", ")}\n`);
process.stdout.write("[worker-profile] next: pm2 restart mood-checker-worker --update-env\n");
