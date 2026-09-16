#!/usr/bin/env node
/*
 * Measures the per-class emotion bias for a particular face and camera.
 *
 * Emotion models carry an offset that depends on the face AND on the optics:
 * a resting face can read as mildly sad, or a camera's contrast and compression
 * can make "happy" bleed onto neutral faces. Every frame agrees, so no amount of
 * temporal smoothing helps — the decision boundary has to move instead.
 *
 * Usage — with the stack running, stand in front of the camera holding the
 * expression you are calibrating, and run:
 *
 *   node scripts/calibrate-emotion.mjs                      # neutral face
 *   node scripts/calibrate-emotion.mjs --label happy        # while smiling
 *   node scripts/calibrate-emotion.mjs --seconds 20 --target 0.95
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
const STREAM =
  (process.env.WORKER_CAMERA_SOURCES || "")
    .split(",")
    .map((pair) => pair.split("=")[1]?.trim())
    .filter(Boolean)[0] || SRC;
const FRAME_URL = (process.env.WORKER_FRAME_API_BASE || "").trim()
  ? `${process.env.WORKER_FRAME_API_BASE.replace(/\/+$/, "")}?src=${STREAM}`
  : `${GO2RTC}/api/frame.jpeg?src=${STREAM}` +
    `&width=${process.env.GO2RTC_FRAME_WIDTH || 1920}` +
    `&height=${process.env.GO2RTC_FRAME_HEIGHT || 1080}` +
    `&quality=${process.env.GO2RTC_FRAME_QUALITY || 82}`;
const SERVICE = (process.env.WORKER_INSIGHTFACE_ENDPOINT || "http://127.0.0.1:8765").replace(
  /\/+$/,
  "",
);

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

const round05 = (value, dir) =>
  dir === "down" ? Math.floor(value * 20) / 20 : Math.ceil(value * 20) / 20;

async function main() {
  console.log(`\nCalibrating "${LABEL}" for ${SECONDS}s.`);
  console.log(`Hold a genuine "${LABEL}" expression and look at the camera.\n`);

  const health = await fetch(`${SERVICE}/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (!health?.emotionEnabled) {
    console.error(`No emotion model at ${SERVICE}. Is the worker running?`);
    return 1;
  }
  if (health.emotionClassBias) {
    console.log(`NOTE: a bias is already active: ${JSON.stringify(health.emotionClassBias)}`);
    console.log("      Numbers below are measured THROUGH it, so they refine rather than");
    console.log("      replace it. Clear WORKER_EMOTION_CLASS_BIAS and restart for a");
    console.log("      reading of the raw model.\n");
  }

  const samples = []; // full score vector of every frame
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
    winners.set(
      own >= bestOther ? LABEL : bestOtherKey,
      (winners.get(own >= bestOther ? LABEL : bestOtherKey) ?? 0) + 1,
    );
    samples.push(scores);

    if (Date.now() - lastDot > 1000) {
      process.stdout.write(".");
      lastDot = Date.now();
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write("\n\n");

  if (frames < 10) {
    console.error(`Only ${frames} usable frames (${noFace} without a face).`);
    console.error("Is the camera reachable and is a face in view? Check: npm run diagnose");
    return 1;
  }

  const correct = winners.get(LABEL) ?? 0;
  console.log(`frames analysed  : ${frames}`);
  console.log(`"${LABEL}" won        : ${correct} (${((correct / frames) * 100).toFixed(0)}%)`);

  if (correct === frames) {
    console.log(`\nNothing to change — "${LABEL}" already wins every frame.`);
    console.log("If the stored label still looks wrong, the problem is in the aggregation");
    console.log("window, not the model: see WORKER_EMOTION_WINDOW_MS.\n");
    return 0;
  }

  console.log("what the model saw instead:");
  for (const [key, count] of [...winners.entries()].sort((a, b) => b[1] - a[1])) {
    if (key === LABEL) continue;
    console.log(`   ${key.padEnd(10)} ${count} frame(s)  ${((count / frames) * 100).toFixed(0)}%`);
  }

  /*
   * Two ways to fix the same misread, and the right one depends on its shape.
   * Lifting LABEL raises it against EVERY class — correct when the model is
   * generally under-confident about it. Damping one rival is surgical and leaves
   * the other emotions untouched — correct when a single class is bleeding onto
   * faces where it does not belong.
   */
  const rivals = [];
  for (const key of Object.keys(samples[0] ?? {})) {
    if (key === LABEL) continue;
    const beat = samples.filter(
      (scores) => Number(scores[key] ?? 0) > Number(scores[LABEL] ?? 0),
    ).length;
    if (!beat) continue;
    // How far this rival must be scaled down to stop outranking LABEL.
    const ratios = samples
      .map((scores) => {
        const own = Number(scores[LABEL] ?? 0);
        const rival = Number(scores[key] ?? 0);
        return rival > 0 ? own / rival : Number.POSITIVE_INFINITY;
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!ratios.length) continue;
    const needed = quantile(ratios, 1 - TARGET);
    if (needed < 0.98) {
      rivals.push({ key, multiplier: Math.max(0.05, round05(needed * 0.95, "down")), beat });
    }
  }
  rivals.sort((a, b) => b.beat - a.beat);

  // Lifting LABEL: it has to clear whichever rival is strongest in each frame.
  const lifts = samples
    .map((scores) => {
      const own = Number(scores[LABEL] ?? 0);
      let best = 0;
      for (const [key, value] of Object.entries(scores)) {
        if (key !== LABEL && Number(value) > best) best = Number(value);
      }
      return own > 0 ? best / own : Number.POSITIVE_INFINITY;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const lift = Math.max(1, round05(quantile(lifts, TARGET) * 1.05, "up"));

  console.log(`\nTo make "${LABEL}" win ${(TARGET * 100).toFixed(0)}% of these frames:\n`);

  if (rivals.length) {
    console.log("  damp only the classes that actually intrude (surgical):");
    for (const item of rivals) {
      console.log(
        `     ${item.key.padEnd(10)} x${item.multiplier.toFixed(2)}   ` +
          `outranked "${LABEL}" in ${item.beat} of ${frames} frames`,
      );
    }
    const line = rivals.map((item) => `${item.key}=${item.multiplier.toFixed(2)}`).join(",");
    console.log(`\n     WORKER_EMOTION_CLASS_BIAS=${line}\n`);

    const harsh = rivals.filter((item) => item.multiplier <= 0.3);
    if (harsh.length) {
      console.log(`  WARNING: ${harsh.map((h) => h.key).join(", ")} would be damped very hard.`);
      console.log("  That suppresses the emotion everywhere, not only on this face. Verify it");
      console.log("  is still detected when genuinely present before keeping the value.\n");
    }
  }

  if (lift > 1.01) {
    console.log(`  or lift "${LABEL}" against everything (blunt):\n`);
    console.log(`     WORKER_EMOTION_CLASS_BIAS=${LABEL}=${lift.toFixed(2)}\n`);
  }

  console.log("Entries combine, so both forms can sit on one line.");
  console.log("After editing .env.worker restart the worker, then check the other direction");
  console.log("so the fix has not blinded the model to a real expression:");
  console.log("  node scripts/calibrate-emotion.mjs --label happy   (while actually smiling)\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("calibration failed:", err);
    process.exit(1);
  });
