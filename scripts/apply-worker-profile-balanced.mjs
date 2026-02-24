#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.worker");

const cameraSettings = {
  "cam-01": {
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
    sessionSnapshotIntervalMs: 900,
    sessionResolveWaitMs: 1300,
    sessionMinSamples: 2,
    sessionMinEmotionSamples: 1,
    sessionAbsenceMs: 2300,
    recognitionHoldMs: 2200,
  },
  "cam-02": {
    confirmFrames: 1,
    minConfirmScore: 0.11,
    filterMinScore: 0.08,
    personMinScore: 0.14,
    personMinSidePx: 18,
    personMinStreak: 1,
    matchThreshold: 0.53,
    matchMinMargin: 0.05,
    matchMinFaceSidePx: 18,
    matchIntervalMs: 100,
    emotionMinConfidence: 0.15,
    emotionLowConfidenceFloor: 0.08,
    sessionSnapshotIntervalMs: 800,
    sessionResolveWaitMs: 1500,
    sessionMinSamples: 2,
    sessionMinEmotionSamples: 1,
    sessionAbsenceMs: 2700,
    recognitionHoldMs: 2800,
  },
};

const updates = new Map([
  ["WORKER_FRAME_TIMEOUT_MS", "2200"],
  ["WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", "3500"],
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
