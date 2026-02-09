#!/usr/bin/env node
/* Detection-only worker using the same model family/logic as browser face-api. */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import "@tensorflow/tfjs-node";
import * as faceapi from "@vladmandic/face-api";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(message) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  process.stdout.write(`[node-detection-worker ${ts}] ${message}\n`);
}

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const v = line.trim();
    if (!v || v.startsWith("#")) continue;
    const eq = v.indexOf("=");
    if (eq <= 0) continue;
    const key = v.slice(0, eq).trim();
    const val = stripQuotes(v.slice(eq + 1));
    if (key && process.env[key] == null) process.env[key] = val;
  }
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name, fallback) {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function parseCameraSources() {
  const explicit = (process.env.WORKER_CAMERA_SOURCES ?? "").trim();
  const list = [];
  if (explicit) {
    for (const part of explicit.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const [left, right] = p.split("=");
      if (right && left) {
        list.push({ cameraId: left.trim(), src: right.trim() });
      } else {
        list.push({ cameraId: `cam-${String(list.length + 1).padStart(2, "0")}`, src: left.trim() });
      }
    }
    return list;
  }

  for (let i = 1; i <= 4; i += 1) {
    const src = (process.env[`NEXT_PUBLIC_CAMERA_${i}_GO2RTC_SRC`] ?? "").trim();
    if (src) {
      list.push({ cameraId: `cam-${String(i).padStart(2, "0")}`, src });
    }
  }
  return list;
}

function getBox(det) {
  const box = det?.box ?? det?.detection?.box;
  if (!box) return null;
  return {
    x: Number(box.x ?? 0),
    y: Number(box.y ?? 0),
    width: Number(box.width ?? 0),
    height: Number(box.height ?? 0),
  };
}

function getScore(det) {
  const score = det?.score ?? det?.detection?.score;
  return Number.isFinite(score) ? Number(score) : 0;
}

function iou(a, b) {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function computeLumaBufferFromRgb(rgb) {
  const luma = new Uint8Array(Math.floor(rgb.length / 3));
  let j = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    luma[j++] = (77 * rgb[i] + 150 * rgb[i + 1] + 29 * rgb[i + 2]) >> 8;
  }
  return luma;
}

function computeMotionScore(prev, next) {
  if (!prev || prev.length !== next.length) return 0;
  let sum = 0;
  for (let i = 0; i < next.length; i += 1) {
    sum += Math.abs(next[i] - prev[i]);
  }
  return sum / next.length;
}

function filterAndDedupeDetections(
  detections,
  frameWidth,
  frameHeight,
  {
    minSidePxBase,
    minSideRatio,
    minAreaRatio,
    maxAreaRatio,
    minScore,
    minAspect,
    maxAspect,
  },
) {
  const minSidePx = Math.max(minSidePxBase, Math.floor(Math.min(frameWidth, frameHeight) * minSideRatio));
  const minArea = frameWidth * frameHeight * minAreaRatio;
  const maxArea = frameWidth * frameHeight * maxAreaRatio;

  const filtered = detections.filter((det) => {
    const box = getBox(det);
    if (!box) return false;
    const score = getScore(det);
    const area = box.width * box.height;
    const ratio = box.width / Math.max(1, box.height);
    const plausibleShape = ratio >= minAspect && ratio <= maxAspect;
    const plausibleSize =
      box.width >= minSidePx &&
      box.height >= minSidePx &&
      area >= minArea &&
      area <= maxArea;
    const edge = Math.max(2, Math.floor(frameWidth * 0.005));
    const notNearEdge =
      box.x >= edge &&
      box.y >= edge &&
      box.x + box.width <= frameWidth - edge &&
      box.y + box.height <= frameHeight - edge;
    return score >= minScore && plausibleShape && plausibleSize && notNearEdge;
  });

  filtered.sort((a, b) => getScore(b) - getScore(a));
  const deduped = [];
  for (const det of filtered) {
    const box = getBox(det);
    if (!box) continue;
    const overlaps = deduped.some((kept) => {
      const kb = getBox(kept);
      return kb ? iou(box, kb) > 0.45 : false;
    });
    if (!overlaps) deduped.push(det);
  }
  return deduped;
}

function largestFaceStats(detections) {
  let maxSide = 0;
  let maxScore = 0;
  for (const det of detections) {
    const b = getBox(det);
    if (!b) continue;
    maxSide = Math.max(maxSide, b.width, b.height);
    maxScore = Math.max(maxScore, getScore(det));
  }
  return { maxSide, maxScore };
}

function rgbaToRgbTensorData(rgba) {
  const rgb = new Uint8Array(Math.floor((rgba.length / 4) * 3));
  let j = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    rgb[j++] = rgba[i];
    rgb[j++] = rgba[i + 1];
    rgb[j++] = rgba[i + 2];
  }
  return rgb;
}

async function fetchFrame(frameUrl, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${frameUrl}&t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "image/jpeg" },
    });
    if (!res.ok) throw new Error(`frame_http_${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

async function writeStatusFile(filePath, payload) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload), "utf-8");
  await fsp.rename(tmp, filePath);
}

function createState(cameraId, src) {
  return {
    cameraId,
    src,
    candidate: 0,
    confirmed: 0,
    score: 0,
    motion: 0,
    streak: 0,
    lastConfirmedAt: 0,
    lastBestBox: null,
    prevLuma: null,
    lastCandidateLogAt: 0,
    lastConfirmLogAt: 0,
    lastErrLogAt: 0,
  };
}

async function main() {
  loadEnvFile(path.join(rootDir, ".env.worker"));
  loadEnvFile(path.join(rootDir, ".env"));

  const cameras = parseCameraSources();
  if (!cameras.length) {
    log("no cameras configured (set WORKER_CAMERA_SOURCES or NEXT_PUBLIC_CAMERA_*_GO2RTC_SRC)");
    process.exit(1);
  }

  const statusFile = process.env.WORKER_STATUS_FILE || "/tmp/mood-checker-worker-status.json";
  const statusDir = path.dirname(statusFile);
  await fsp.mkdir(statusDir, { recursive: true }).catch(() => {});

  const frameApiBase =
    (process.env.WORKER_FRAME_API_BASE || "http://127.0.0.1:3000/api/camera/frame").replace(/\/+$/, "");
  const frameTimeoutMs = Math.max(700, envInt("WORKER_FRAME_TIMEOUT_MS", 1800));
  const loopDelayMs = Math.max(20, envInt("WORKER_LOOP_DELAY_MS", 80));
  const heartbeatSeconds = Math.max(1, envFloat("WORKER_HEARTBEAT_SECONDS", 5));
  const statusLogSeconds = Math.max(0.4, envFloat("WORKER_STATUS_LOG_SECONDS", 1.0));
  const detectionLogCooldownMs = Math.max(200, envInt("WORKER_DETECTION_LOG_COOLDOWN_MS", 500));
  const candidateLogCooldownMs = Math.max(200, envInt("WORKER_CANDIDATE_LOG_COOLDOWN_MS", 700));
  const confirmFrames = Math.max(1, envInt("WORKER_CONFIRM_FRAMES", 1));
  const motionThreshold = envFloat("WORKER_MOTION_THRESHOLD", 1.5);
  const minConfirmScore = envFloat("WORKER_MIN_CONFIRM_SCORE", 0.18);
  const tinyInputSize = envInt("WORKER_TINY_INPUT_SIZE", 512);
  const tinyScoreThreshold = envFloat("WORKER_TINY_SCORE_THRESHOLD", 0.18);
  const ssdMinConfidence = envFloat("WORKER_SSD_MIN_CONFIDENCE", 0.35);
  const useSsdFallback = envBool("WORKER_USE_SSD_FALLBACK", false);
  const fastPassMode = envBool("WORKER_FAST_PASS_MODE", true);
  const filterMinScore = envFloat("WORKER_FILTER_MIN_SCORE", 0.12);
  const filterMinSidePx = envInt("WORKER_FILTER_MIN_SIDE_PX", 12);
  const filterMinSideRatio = envFloat("WORKER_FILTER_MIN_SIDE_RATIO", 0.015);
  const filterMinAreaRatio = envFloat("WORKER_FILTER_MIN_AREA_RATIO", 0.0005);
  const filterMaxAreaRatio = envFloat("WORKER_FILTER_MAX_AREA_RATIO", 0.72);
  const filterMinAspect = envFloat("WORKER_FILTER_MIN_ASPECT", 0.52);
  const filterMaxAspect = envFloat("WORKER_FILTER_MAX_ASPECT", 1.9);

  const modelDir = path.join(rootDir, "public", "models");
  if (!fs.existsSync(modelDir)) {
    log(`model dir not found: ${modelDir}`);
    process.exit(1);
  }

  faceapi.tf.enableProdMode();
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
  let ssdLoaded = false;
  if (useSsdFallback) {
    try {
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
      ssdLoaded = true;
    } catch (err) {
      log(`ssd fallback disabled (load failed): ${String(err)}`);
    }
  }
  const tinyOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: tinyInputSize,
    scoreThreshold: tinyScoreThreshold,
  });
  const ssdOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: ssdMinConfidence });
  log(
    `detector=face-api tiny(input=${tinyInputSize},score=${tinyScoreThreshold}) ` +
      `ssd_fallback=${ssdLoaded ? "on" : "off"}`,
  );

  const states = cameras.map((c) => createState(c.cameraId, c.src));
  log(`started cameras=${states.length} frame_api=${frameApiBase}`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastHeartbeatAt = 0;
  let lastStatusAt = 0;

  while (!stopping) {
    const now = Date.now();
    let confirmedTotal = 0;

    for (const cam of states) {
      const frameUrl = `${frameApiBase}?src=${encodeURIComponent(cam.src)}`;

      try {
        const jpg = await fetchFrame(frameUrl, frameTimeoutMs);
        const image = await loadImage(jpg);
        const w = Number(image.width ?? 0);
        const h = Number(image.height ?? 0);
        if (!w || !h) {
          throw new Error("invalid_image");
        }

        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const rgb = rgbaToRgbTensorData(rgba);
        // Keep dtype close to browser fromPixels() behavior used by face-api in client mode.
        const frameTensor = faceapi.tf.tensor3d(rgb, [h, w, 3], "int32");

        let detections = [];
        try {
          detections = await faceapi.detectAllFaces(frameTensor, tinyOptions);
          if (!detections.length && ssdLoaded) {
            detections = await faceapi.detectAllFaces(frameTensor, ssdOptions);
          }
        } finally {
          const resized = faceapi.tf.image.resizeBilinear(frameTensor, [54, 96], true);
          const rgb = await resized.data();
          resized.dispose();
          frameTensor.dispose();

          const nextLuma = computeLumaBufferFromRgb(rgb);
          cam.motion = computeMotionScore(cam.prevLuma, nextLuma);
          cam.prevLuma = nextLuma;
        }

        detections = filterAndDedupeDetections(detections, w, h, {
          minSidePxBase: filterMinSidePx,
          minSideRatio: filterMinSideRatio,
          minAreaRatio: filterMinAreaRatio,
          maxAreaRatio: filterMaxAreaRatio,
          minScore: filterMinScore,
          minAspect: filterMinAspect,
          maxAspect: filterMaxAspect,
        });
        cam.candidate = detections.length;

        const { maxSide, maxScore } = largestFaceStats(detections);
        cam.score = maxScore;

        const best = detections[0];
        const bestBox = getBox(best);
        const trackStable = Boolean(
          bestBox && cam.lastBestBox && iou(bestBox, cam.lastBestBox) > 0.08,
        );
        if (bestBox) cam.lastBestBox = bestBox;
        if (!bestBox) cam.lastBestBox = null;

        if (cam.candidate > 0) {
          if (trackStable || cam.streak === 0) cam.streak += 1;
          else cam.streak = 1;
        } else {
          cam.streak = 0;
        }

        const recentConfirm = now - cam.lastConfirmedAt < 2500;
        const motionGate =
          cam.motion >= motionThreshold || recentConfirm || maxScore >= 0.65 || maxSide >= 150;
        const isConfirmed =
          cam.candidate > 0 &&
          cam.streak >= confirmFrames &&
          maxScore >= minConfirmScore &&
          (fastPassMode ? true : motionGate);
        cam.confirmed = isConfirmed ? cam.candidate : 0;
        if (isConfirmed) {
          cam.lastConfirmedAt = now;
          confirmedTotal += cam.confirmed;
          if (now - cam.lastConfirmLogAt >= detectionLogCooldownMs) {
            log(
              `[${cam.cameraId}] face_detected count=${cam.confirmed} ` +
                `score=${cam.score.toFixed(3)} motion=${cam.motion.toFixed(2)}`,
            );
            cam.lastConfirmLogAt = now;
          }
        } else if (cam.candidate > 0 && now - cam.lastCandidateLogAt >= candidateLogCooldownMs) {
          log(
            `[${cam.cameraId}] candidate_detected count=${cam.candidate} ` +
              `score=${cam.score.toFixed(3)} motion=${cam.motion.toFixed(2)} ` +
              `streak=${cam.streak}/${confirmFrames}`,
          );
          cam.lastCandidateLogAt = now;
        }
      } catch (err) {
        cam.candidate = 0;
        cam.confirmed = 0;
        cam.score = 0;
        cam.streak = 0;
        if (now - cam.lastErrLogAt >= 2000) {
          log(`[${cam.cameraId}] frame error: ${String(err)}`);
          cam.lastErrLogAt = now;
        }
      }
    }

    if (now - lastHeartbeatAt >= heartbeatSeconds * 1000) {
      log(
        `heartbeat: cameras_ready=${states.length}/${states.length} faces_detected=${confirmedTotal}`,
      );
      lastHeartbeatAt = now;
    }

    if (now - lastStatusAt >= statusLogSeconds * 1000) {
      const payload = {
        ts: new Date().toISOString(),
        cameras: {},
      };
      for (const cam of states) {
        log(
          `[${cam.cameraId}] status candidate=${cam.candidate} confirmed=${cam.confirmed} ` +
            `score=${cam.score.toFixed(3)} motion=${cam.motion.toFixed(2)} ` +
            `streak=${cam.streak}/${confirmFrames}`,
        );
        payload.cameras[cam.cameraId] = {
          candidate: cam.candidate,
          confirmed: cam.confirmed,
          score: Number(cam.score.toFixed(3)),
          motion: Number(cam.motion.toFixed(2)),
          streak: cam.streak,
          requiredFrames: confirmFrames,
        };
      }
      try {
        await writeStatusFile(statusFile, payload);
      } catch (err) {
        log(`status file write failed: ${String(err)}`);
      }
      lastStatusAt = now;
    }

    await sleep(loopDelayMs);
  }

  log("stop signal received");
}

main().catch((err) => {
  process.stderr.write(`[node-detection-worker] fatal: ${String(err)}\n`);
  process.exit(1);
});
