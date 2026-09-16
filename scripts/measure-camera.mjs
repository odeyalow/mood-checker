#!/usr/bin/env node
/*
 * Measures how fast frames can actually be pulled from the camera, and what that
 * means for someone walking past.
 *
 * The worker fetches one JPEG per HTTP request. go2rtc has to wait for a keyframe
 * to answer each one, so the achievable rate is set by the recorder's I-frame
 * interval, not by the detector. If a pass yields three frames, no threshold
 * tuning will make recognition reliable.
 *
 * Also times go2rtc's continuous MJPEG endpoint, which has no per-frame keyframe
 * wait — so the gain from switching the worker to it can be seen before writing
 * any code.
 *
 *   node scripts/measure-camera.mjs
 *   node scripts/measure-camera.mjs --samples 25 --walk 1.4
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

const SAMPLES = Math.max(5, Number.parseInt(arg("--samples", "20"), 10));
const WALK_SPEED = Number.parseFloat(arg("--walk", "1.4")); // m/s, normal indoor pace
const CROSS_METRES = Number.parseFloat(arg("--cross", "3")); // width of the useful zone

const GO2RTC = (process.env.GO2RTC_BASE_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const STREAM =
  (process.env.WORKER_CAMERA_SOURCES || "")
    .split(",")
    .map((pair) => pair.split("=")[1]?.trim())
    .filter(Boolean)[0] || "cam01_main";
const WIDTH = process.env.GO2RTC_FRAME_WIDTH || 1920;
const HEIGHT = process.env.GO2RTC_FRAME_HEIGHT || 1080;
const QUALITY = process.env.GO2RTC_FRAME_QUALITY || 82;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function measureSnapshots() {
  const url =
    `${GO2RTC}/api/frame.jpeg?src=${STREAM}&width=${WIDTH}&height=${HEIGHT}&quality=${QUALITY}`;
  const times = [];
  let bytes = 0;
  process.stdout.write("  ");
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = Date.now();
    try {
      const res = await fetch(`${url}&t=${started}`, { cache: "no-store" });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.length > 1000) {
        times.push(Date.now() - started);
        bytes += buf.length;
      }
    } catch {
      /* counted as a miss */
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return { times: times.sort((a, b) => a - b), bytes, attempted: SAMPLES };
}

/** Counts JPEG start-of-image markers on the continuous MJPEG stream. */
async function measureMjpeg(seconds = 6) {
  const url = `${GO2RTC}/api/stream.mjpeg?src=${STREAM}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  let frames = 0;
  let bytes = 0;
  let firstAt = 0;
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) return null;
    let tail = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      for (let i = 0; i < buf.length - 1; i += 1) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
          frames += 1;
          if (!firstAt) firstAt = Date.now();
        }
      }
      tail = buf.length;
      void tail;
    }
  } catch {
    /* aborted on purpose, or the endpoint is unavailable */
  } finally {
    clearTimeout(timer);
  }
  const elapsed = (Date.now() - (firstAt || started)) / 1000;
  if (!frames || elapsed <= 0) return null;
  return { frames, fps: frames / elapsed, bytes, elapsed };
}

async function main() {
  console.log(`\nCamera throughput — stream "${STREAM}" at ${WIDTH}x${HEIGHT} q${QUALITY}\n`);

  console.log(`1. One JPEG per request (what the worker does now), ${SAMPLES} samples`);
  const snap = await measureSnapshots();
  if (!snap.times.length) {
    console.error("   no frames came back — check: npm run diagnose\n");
    return 1;
  }
  const median = pct(snap.times, 0.5);
  const p90 = pct(snap.times, 0.9);
  const fps = 1000 / median;
  console.log(
    `   median ${median} ms   p90 ${p90} ms   min ${snap.times[0]} ms   max ${snap.times.at(-1)} ms`,
  );
  console.log(`   => about ${fps.toFixed(1)} frames/second`);
  console.log(`   average size ${(snap.bytes / snap.times.length / 1024).toFixed(0)} KB\n`);

  // The spread between fastest and slowest request is roughly the keyframe period:
  // a request arriving just after an I-frame waits for the next one.
  const spread = snap.times.at(-1) - snap.times[0];
  if (spread > 400) {
    console.log(`   The ${spread} ms spread between fastest and slowest points at the`);
    console.log("   recorder's I-frame interval: each request waits for the next keyframe.");
    console.log("   Lowering \"I Frame Interval\" (GOP) on the recorder attacks this directly.\n");
  }

  console.log("2. Continuous MJPEG (no per-frame keyframe wait)");
  const mjpeg = await measureMjpeg();
  if (mjpeg) {
    console.log(`   ${mjpeg.frames} frames in ${mjpeg.elapsed.toFixed(1)} s`);
    console.log(`   => about ${mjpeg.fps.toFixed(1)} frames/second`);
    console.log(`   bandwidth ${((mjpeg.bytes / mjpeg.elapsed / 1024 / 1024) * 8).toFixed(1)} Mbit/s\n`);
  } else {
    console.log("   endpoint did not deliver frames — go2rtc may not expose it for this source\n");
  }

  const passSeconds = CROSS_METRES / WALK_SPEED;
  console.log(
    `3. Someone walking ${WALK_SPEED} m/s across ${CROSS_METRES} m is in view for ` +
      `${passSeconds.toFixed(1)} s\n`,
  );
  const now = fps * passSeconds;
  console.log(`   at the current rate : ${now.toFixed(1)} frames per pass`);
  if (mjpeg) {
    console.log(`   over MJPEG          : ${(mjpeg.fps * passSeconds).toFixed(1)} frames per pass`);
  }
  console.log();

  if (now < 6) {
    console.log("   Under ~6 frames a pass, recognition is a coin flip: the face also has to");
    console.log("   be frontal, in focus and large enough in at least one of them. Tuning");
    console.log("   thresholds cannot compensate for frames that were never captured.\n");
  } else {
    console.log("   That is enough frames for the pose and size gates to have something to");
    console.log("   work with — if recognition still misses, the thresholds are worth a look.\n");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("measurement failed:", err);
    process.exit(1);
  });
