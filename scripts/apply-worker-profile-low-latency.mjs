#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.worker");

const cameraSettings = {
  "cam-01": {
    frameOffsetY: 0,
    confirmFrames: 1,
    minConfirmScore: 0.11,
    filterMinScore: 0.085,
    personMinScore: 0.15,
    personMinSidePx: 18,
    personMinStreak: 1,
    matchThreshold: 0.56,
    matchMinMargin: 0.035,
    matchMinFaceSidePx: 14,
    matchIntervalMs: 90,
    emotionIntervalMs: 450,
    emotionMinConfidence: 0.12,
    emotionLowConfidenceFloor: 0.05,
    sessionSnapshotIntervalMs: 250,
    sessionResolveWaitMs: 250,
    sessionMinSamples: 1,
    sessionMinEmotionSamples: 1,
    sessionAbsenceMs: 2600,
    recognitionHoldMs: 1600,
    newIdConfirmFrames: 1,
    newIdMinScore: 0.13,
    newIdMinFaceSidePx: 18,
    newIdEmptyMinScore: 0.15,
    newIdEmptyMinFaceSidePx: 18,
    newIdMinSharpness: 8,
    newIdEmptyMinSharpness: 9,
  },
};

const updates = new Map([
  ["WORKER_CAMERA_SOURCES", "cam-01=cam01_main"],
  ["WORKER_FRAME_API_BASE", "http://127.0.0.1:1984/api/frame.jpeg?width=1920&height=1080&quality=92"],
  ["WORKER_FRAME_TIMEOUT_MS", "3600"],
  ["WORKER_FRAME_ABORT_RETRY_ENABLED", "true"],
  ["WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", "5200"],
  ["WORKER_FRAME_ABORT_RETRY_WIDTH", "1600"],
  ["WORKER_FRAME_ABORT_RETRY_HEIGHT", "900"],
  ["WORKER_FRAME_ABORT_RETRY_QUALITY", "84"],
  ["WORKER_IMAGE_DECODE_TIMEOUT_MS", "1200"],
  ["WORKER_CAMERA_PROCESS_TIMEOUT_MS", "9000"],
  ["WORKER_PARALLEL_CAMERAS", "1"],
  ["WORKER_LOOP_DELAY_MS", "25"],
  ["WORKER_INSIGHTFACE_TIMEOUT_MS", "4500"],
  ["WORKER_MATCH_INTERVAL_MS", "90"],
  ["WORKER_EMOTION_INTERVAL_MS", "450"],
  ["WORKER_IDENTIFY_MIN_INTERVAL_MS", "600"],
  ["WORKER_AUTO_CREATE_COOLDOWN_MS", "1200"],
  ["WORKER_DB_COOLDOWN_MS", "1200"],
  ["WORKER_DB_REENTRY_GAP_MS", "700"],
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
