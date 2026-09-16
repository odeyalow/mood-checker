#!/usr/bin/env node
/*
 * Measures the per-class emotion bias for a particular face.
 *
 * Emotion models carry a person-specific offset: a resting face can read as
 * mildly sad or angry, and every frame agrees, so no amount of temporal
 * smoothing helps. This samples real frames of YOUR neutral face and computes
 * the multiplier that moves the decision boundary just far enough.
 *
 * Usage — with the stack running (`npm run dev:all`), stand in front of the
 * camera with a relaxed neutral face and run:
 *
 *   node scripts/calibrate-emotion.mjs
 *   node scripts/calibrate-emotion.mjs --seconds 20 --target 0.95
 *   node scripts/calibrate-emotion.mjs --label neutral
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnvFile(file, { override = false } = {}) {
  const abs = path.join(ROOT_DIR, file);
  if (!fs.existsSync(abs)) return;
  for (const line of fs.readFileSync(abs, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] == null) process.env[key] = value;
  }
}
loadEnvFile(".env.worker", { override: true });
loadEnvFile(".env");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const SECONDS = Number.parseFloat(arg("--seconds", "15"));
const TARGET = Math.min(0.999, Math.max(0.5, Number.parseFloat(arg("--target", "0.9"))));
const LABEL = String(arg("--label", "neutral")).toLowerCase();
const SRC = arg("--src", "cam-01");

// Same source the worker uses: go2rtc directly unless overridden.
const GO2RTC = (process.env.GO2RTC_BASE_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const STREAM = (process.env.WORKER_CAMERA_SOURCES || "")
  .split(",")
  .map((pair) => pair.split("=")[1]?.trim())
  .filter(Boolean)[0] || SRC;
const FRAME_URL = (process.env.WORKER_FRAME_API_BASE || "").trim()
  ? `${process.env.WORKER_FRAME_API_BASE.replace(/\/+$/, "")}?src=${STREAM}`
  : `${GO2RTC}/api/frame.jpeg?src=${STREAM}` +
    `&width=${process.env.GO2RTC_FRAME_WIDTH || 1920}` +
    `&height=${process.env.GO2RTC_FRAME_HEIGHT || 1080}` +
    `&quality=${process.env.GO2RTC_FRAME_QUALITY || 82}`;
const SERVICE = (process.env.WORKER_INSIGHTFACE_ENDPOINT || "http://127.0.0.1:8765").replace(/\/+$/, "");

async function grabFrame() {
  const res = await fetch(FRAME_URL, { cache: "no-store" });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function analyze(jpeg) {
  const res = await fetch(`${SERVICE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: jpeg.toString("base64"),
      rgbBase64: "",
      includeDescriptor: false,
      includeEmotions: true,
      maxFaces: 1,
      minScore: 0.05,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const face = Array.isArray(data?.faces) ? data.faces[0] : null;
  return face?.expressions ?? null;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function main() {
  console.log(`\nCalibrating "${LABEL}" for ${SECONDS}s.`);
  console.log("Hold a relaxed, neutral expression and look at the camera.\n");

  const health = await fetch(`${SERVICE}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.emotionEnabled) {
    console.error(`No emotion model at ${SERVICE}. Start the stack first (npm run dev:all).`);
    return 1;
  }
  if (health.emotionClassBias) {
    console.log(`NOTE: a bias is already active: ${JSON.stringify(health.emotionClassBias)}`);
    console.log("      Clear WORKER_EMOTION_CLASS_BIAS and restart before calibrating.\n");
  }

  const ratios = [];        // how much `LABEL` must be scaled to win this frame
  const winners = new Map();
  let frames = 0;
  let noFace = 0;
  const endAt = Date.now() + SECONDS * 1000;
  let lastDot = 0;

  while (Date.now() < endAt) {
    const jpeg = await grabFrame();
    if (!jpeg) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const scores = await analyze(jpeg);
    if (!scores) {
      noFace += 1;
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    frames += 1;

    const own = Number(scores[LABEL] ?? 0);
    let bestOther = 0;
    let bestOtherKey = "";
    for (const [key, value] of Object.entries(scores)) {
      if (key === LABEL) continue;
      if (Number(value) > bestOther) {
        bestOther = Number(value);
        bestOtherKey = key;
      }
    }
    const winner = own >= bestOther ? LABEL : bestOtherKey;
    winners.set(winner, (winners.get(winner) ?? 0) + 1);
    ratios.push(own > 0 ? bestOther / own : Number.POSITIVE_INFINITY);

    if (Date.now() - lastDot > 1000) {
      process.stdout.write(".");
      lastDot = Date.now();
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write("\n\n");

  if (frames < 10) {
    console.error(`Only ${frames} usable frames (${noFace} without a face).`);
    console.error("Is the camera reachable? Check: npm run diagnose");
    return 1;
  }

  const sorted = ratios.filter(Number.isFinite).sort((a, b) => a - b);
  const correct = winners.get(LABEL) ?? 0;
  console.log(`frames analysed : ${frames}`);
  console.log(`"${LABEL}" already won : ${correct} (${((correct / frames) * 100).toFixed(0)}%)`);
  console.log("what the model saw instead:");
  for (const [key, count] of [...winners.entries()].sort((a, b) => b[1] - a[1])) {
    if (key === LABEL) continue;
    console.log(`   ${key.padEnd(10)} ${count} frame(s)  ${((count / frames) * 100).toFixed(0)}%`);
  }

  const needed = quantile(sorted, TARGET);
  const recommended = Math.max(1, Math.ceil(needed * 1.05 * 20) / 20); // round up to .05
  console.log(`\nto win ${(TARGET * 100).toFixed(0)}% of frames, "${LABEL}" needs x${needed.toFixed(2)}`);

  if (recommended <= 1.01) {
    console.log("\nNo bias needed — the model already reads this face correctly.");
    console.log("If it still looks wrong in the DB, the issue is aggregation, not the model.");
    return 0;
  }
  console.log(`\nAdd to .env.worker and restart:\n`);
  console.log(`  WORKER_EMOTION_CLASS_BIAS=${LABEL}=${recommended.toFixed(2)}\n`);
  console.log("Then re-run this to confirm, and check a real smile is still detected:");
  console.log("  node scripts/calibrate-emotion.mjs --label happy   (while smiling)\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("calibration failed:", err);
    process.exit(1);
  });
