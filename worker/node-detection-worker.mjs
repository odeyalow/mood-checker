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

function labelFromFilename(fileName) {
  return fileName.replace(/\.[^/.]+$/, "").trim();
}

function normalizeKnownList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
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

function getFaceSide(det) {
  const box = getBox(det);
  if (!box) return 0;
  return Math.max(Number(box.width) || 0, Number(box.height) || 0);
}

function computeMatchCandidates(labeledDescriptors, descriptor) {
  if (!Array.isArray(labeledDescriptors) || !labeledDescriptors.length || !descriptor) return [];
  const ranked = [];
  for (const item of labeledDescriptors) {
    const label = String(item?.label ?? "").trim();
    const descriptors = Array.isArray(item?.descriptors) ? item.descriptors : [];
    if (!label || !descriptors.length) continue;

    let minDistance = Number.POSITIVE_INFINITY;
    for (const known of descriptors) {
      const dist = Number(faceapi.euclideanDistance(descriptor, known));
      if (Number.isFinite(dist) && dist < minDistance) minDistance = dist;
    }

    if (Number.isFinite(minDistance)) {
      ranked.push({ label, distance: minDistance });
    }
  }

  ranked.sort((a, b) => a.distance - b.distance);
  return ranked;
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
    matchedNames: [],
    matchDistance: 0,
    people: [],
    emotionSummary: "",
    topEmotion: "",
    snapshotUrl: "",
    lastRecognitionAt: 0,
    lastConfirmedAt: 0,
    lastMatchAt: 0,
    lastSnapshotAt: 0,
    lastSnapshotSavedAt: 0,
    lastEmotionAt: 0,
    lastBestBox: null,
    prevLuma: null,
    lastCandidateLogAt: 0,
    lastConfirmLogAt: 0,
    lastMatchLogAt: 0,
    lastEmotionLogAt: 0,
    lastErrLogAt: 0,
    lastDbSentAt: new Map(),
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
  const minConfirmScore = envFloat("WORKER_MIN_CONFIRM_SCORE", 0.14);
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
  const enableMatching = envBool("WORKER_ENABLE_MATCHING", true);
  const matchThreshold = envFloat("WORKER_MATCH_THRESHOLD", 0.52);
  const matchMinMargin = Math.max(0, envFloat("WORKER_MATCH_MIN_MARGIN", 0.035));
  const matchMinFaceSidePx = Math.max(0, envInt("WORKER_MATCH_MIN_FACE_SIDE_PX", 26));
  const matchIntervalMs = Math.max(150, envInt("WORKER_MATCH_INTERVAL_MS", 250));
  const matchLogCooldownMs = Math.max(300, envInt("WORKER_MATCH_LOG_COOLDOWN_MS", 1000));
  const enableEmotions = envBool("WORKER_ENABLE_EMOTIONS", true);
  const emotionIntervalMs = Math.max(150, envInt("WORKER_EMOTION_INTERVAL_MS", 350));
  const snapshotCooldownMs = Math.max(300, envInt("WORKER_SNAPSHOT_COOLDOWN_MS", 1200));
  const dbEndpoint = (process.env.WORKER_DB_ENDPOINT || "http://127.0.0.1:3000/api/recognitions").trim();
  const dbCooldownMs = Math.max(1000, envInt("WORKER_DB_COOLDOWN_MS", 4000));
  const saveSnapshots = envBool("WORKER_SAVE_SNAPSHOTS", true);
  const snapshotSaveCooldownMs = Math.max(200, envInt("WORKER_SNAPSHOT_SAVE_COOLDOWN_MS", 500));
  const snapshotDir = process.env.WORKER_SNAPSHOT_DIR || path.join(rootDir, "public", "_worker-snaps");
  const snapshotPublicBase = (process.env.WORKER_SNAPSHOT_PUBLIC_BASE || "/_worker-snaps").replace(
    /\/+$/,
    "",
  );
  const knownDir = process.env.WORKER_KNOWN_DIR || path.join(rootDir, "public", "known");
  const knownListFile = process.env.WORKER_KNOWN_LIST_FILE || path.join(knownDir, "images.json");

  if (saveSnapshots) {
    await fsp.mkdir(snapshotDir, { recursive: true }).catch(() => {});
  }

  const modelDir = path.join(rootDir, "public", "models");
  if (!fs.existsSync(modelDir)) {
    log(`model dir not found: ${modelDir}`);
    process.exit(1);
  }

  faceapi.tf.enableProdMode();
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
  let matcher = null;
  let knownLabeledDescriptors = [];
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

  if (enableMatching) {
    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(modelDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);

    let knownFiles = [];
    try {
      const raw = await fsp.readFile(knownListFile, "utf-8");
      knownFiles = normalizeKnownList(JSON.parse(raw));
    } catch (err) {
      log(`known list load failed: ${String(err)}`);
    }

    const labeledDescriptors = [];
    for (const fileName of knownFiles) {
      const absPath = path.join(knownDir, fileName);
      try {
        const image = await loadImage(absPath);
        const w = Number(image.width ?? 0);
        const h = Number(image.height ?? 0);
        if (!w || !h) continue;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const rgb = rgbaToRgbTensorData(rgba);
        const knownTensor = faceapi.tf.tensor3d(rgb, [h, w, 3], "int32");

        let det = null;
        try {
          det = await faceapi
            .detectSingleFace(knownTensor, tinyOptions)
            .withFaceLandmarks(true)
            .withFaceDescriptor();
          if (!det && ssdLoaded) {
            det = await faceapi
              .detectSingleFace(knownTensor, ssdOptions)
              .withFaceLandmarks(true)
              .withFaceDescriptor();
          }
        } finally {
          knownTensor.dispose();
        }

        if (det?.descriptor) {
          labeledDescriptors.push(
            new faceapi.LabeledFaceDescriptors(labelFromFilename(fileName), [det.descriptor]),
          );
        }
      } catch (err) {
        log(`known image skipped: ${fileName} (${String(err)})`);
      }
    }

    if (labeledDescriptors.length) {
      knownLabeledDescriptors = labeledDescriptors;
      matcher = new faceapi.FaceMatcher(labeledDescriptors, matchThreshold);
      log(
        `matching=on known=${labeledDescriptors.length} threshold=${matchThreshold} ` +
          `min_margin=${matchMinMargin} min_face_px=${matchMinFaceSidePx}`,
      );
    } else {
      log("matching=off reason=no_known_descriptors");
    }
  } else {
    log("matching=off reason=env_disabled");
  }

  if (enableEmotions) {
    await faceapi.nets.faceExpressionNet.loadFromDisk(modelDir);
  } else {
    log("emotions=off reason=env_disabled");
  }

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
        if (!isConfirmed) {
          cam.matchedNames = [];
          cam.matchDistance = 0;
        }
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

        const needMatch = Boolean(matcher) && now - cam.lastMatchAt >= matchIntervalMs;
        const needEmotion = enableEmotions && now - cam.lastEmotionAt >= emotionIntervalMs;
        const shouldSnapshot =
          cam.confirmed > 0 &&
          (needMatch || needEmotion) &&
          now - cam.lastSnapshotAt >= snapshotCooldownMs;

        if (shouldSnapshot) {
          cam.lastSnapshotAt = now;
          try {
            const snapTensor = faceapi.tf.tensor3d(rgb, [h, w, 3], "int32");
            let results = [];
            const runDetect = async (options) => {
              let task = faceapi.detectAllFaces(snapTensor, options);
              if (matcher) {
                task = task.withFaceLandmarks(true).withFaceDescriptors();
              }
              if (enableEmotions && needEmotion) {
                task = task.withFaceExpressions();
              }
              return task;
            };

            try {
              results = await runDetect(tinyOptions);
              if ((!results || !results.length) && ssdLoaded) {
                results = await runDetect(ssdOptions);
              }
            } finally {
              snapTensor.dispose();
            }

            results = filterAndDedupeDetections(results || [], w, h, {
              minSidePxBase: filterMinSidePx,
              minSideRatio: filterMinSideRatio,
              minAreaRatio: filterMinAreaRatio,
              maxAreaRatio: filterMaxAreaRatio,
              minScore: filterMinScore,
              minAspect: filterMinAspect,
              maxAspect: filterMaxAspect,
            });

            const keys = ["happy", "sad", "angry", "fearful", "disgusted", "surprised"];
            const people = [];
            let bestDistance = 0;
            for (const det of results) {
              let name = "unknown";
              let distance = 0;
              if (matcher && det?.descriptor) {
                const faceSide = getFaceSide(det);
                if (faceSide >= matchMinFaceSidePx) {
                  const ranked = computeMatchCandidates(knownLabeledDescriptors, det.descriptor);
                  const best = ranked[0];
                  const second = ranked[1];
                  const margin = second ? second.distance - best.distance : Number.POSITIVE_INFINITY;
                  const accepted =
                    Boolean(best) &&
                    best.distance <= matchThreshold &&
                    margin >= matchMinMargin;

                  if (accepted) {
                    name = best.label;
                    distance = Number(best.distance) || 0;
                    if (!bestDistance || distance < bestDistance) bestDistance = distance;
                  }
                }
              }

              let emotionLabel = "";
              if (enableEmotions && det?.expressions) {
                let topKey = "";
                let topVal = -1;
                for (const k of keys) {
                  const v = Number(det.expressions[k] ?? 0);
                  if (v > topVal) {
                    topVal = v;
                    topKey = k;
                  }
                }
                emotionLabel = topKey ? `${topKey} ${(topVal * 100).toFixed(0)}%` : "";
              }

              if (name !== "unknown") {
                people.push({
                  name,
                  emotion: emotionLabel,
                  distance: Number(distance.toFixed(3)),
                });
              }
            }

            cam.people = people;
            cam.matchedNames = people.map((p) => p.name);
            cam.matchDistance = people.length ? Number(bestDistance || 0) : 0;
            if (people.length) {
              cam.lastRecognitionAt = now;
            }

            if (
              saveSnapshots &&
              people.length &&
              now - cam.lastSnapshotSavedAt >= snapshotSaveCooldownMs
            ) {
              try {
                const snapshotFile = path.join(snapshotDir, `${cam.cameraId}.jpg`);
                await fsp.writeFile(snapshotFile, jpg);
                cam.snapshotUrl = `${snapshotPublicBase}/${cam.cameraId}.jpg?v=${now}`;
                cam.lastSnapshotSavedAt = now;
              } catch (err) {
                if (now - cam.lastErrLogAt >= 2000) {
                  log(`[${cam.cameraId}] snapshot save error: ${String(err)}`);
                  cam.lastErrLogAt = now;
                }
              }
            }

            if (enableMatching && enableEmotions && people.length) {
              for (const person of people) {
                const moodLabel = String(person.emotion || "").split(" ")[0];
                if (!moodLabel) continue;
                const lastSent = cam.lastDbSentAt.get(person.name) ?? 0;
                if (now - lastSent < dbCooldownMs) continue;
                cam.lastDbSentAt.set(person.name, now);
                try {
                  await fetch(dbEndpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: person.name,
                      mood: moodLabel,
                      detectedAt: new Date().toISOString(),
                      cameraId: cam.cameraId,
                    }),
                  });
                } catch (err) {
                  if (now - cam.lastErrLogAt >= 2000) {
                    log(`[${cam.cameraId}] db send error: ${String(err)}`);
                    cam.lastErrLogAt = now;
                  }
                }
              }
            }

            if (needMatch) {
              cam.lastMatchAt = now;
              if (cam.matchedNames.length && now - cam.lastMatchLogAt >= matchLogCooldownMs) {
                log(
                  `[${cam.cameraId}] matched names=${cam.matchedNames.join(",")} ` +
                    `distance=${cam.matchDistance.toFixed(3)}`,
                );
                cam.lastMatchLogAt = now;
              }
            }

            if (needEmotion) {
              cam.lastEmotionAt = now;
              cam.emotionSummary = people
                .map((p) => `${p.name}:${p.emotion || "-"}`)
                .join(", ");
              cam.topEmotion = people.length ? people[0].emotion || "" : "";
              if (cam.topEmotion && now - cam.lastEmotionLogAt >= 1500) {
                log(`[${cam.cameraId}] emotion top=${cam.topEmotion}`);
                cam.lastEmotionLogAt = now;
              }
            }
          } catch (err) {
            cam.matchedNames = [];
            cam.matchDistance = 0;
            cam.people = [];
            cam.emotionSummary = "";
            cam.topEmotion = "";
            if (now - cam.lastErrLogAt >= 2000) {
              log(`[${cam.cameraId}] snapshot error: ${String(err)}`);
              cam.lastErrLogAt = now;
            }
          }
        } else if ((!enableEmotions && !matcher) || cam.candidate === 0) {
          cam.matchedNames = [];
          cam.matchDistance = 0;
          cam.people = [];
          cam.emotionSummary = "";
          cam.topEmotion = "";
        }
      } catch (err) {
        cam.candidate = 0;
        cam.confirmed = 0;
        cam.score = 0;
        cam.streak = 0;
        cam.matchedNames = [];
        cam.matchDistance = 0;
        cam.emotionSummary = "";
        cam.topEmotion = "";
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
            `streak=${cam.streak}/${confirmFrames} names=${cam.matchedNames.join("|") || "-"} ` +
            `emotion=${cam.topEmotion || "-"}`,
        );
        payload.cameras[cam.cameraId] = {
          candidate: cam.candidate,
          confirmed: cam.confirmed,
          score: Number(cam.score.toFixed(3)),
          motion: Number(cam.motion.toFixed(2)),
          streak: cam.streak,
          requiredFrames: confirmFrames,
          matchedNames: cam.matchedNames,
          matchDistance: Number(cam.matchDistance.toFixed(3)),
          people: cam.people,
          emotionSummary: cam.emotionSummary,
          topEmotion: cam.topEmotion,
          snapshotUrl: cam.snapshotUrl,
          lastRecognitionAt: cam.lastRecognitionAt ? new Date(cam.lastRecognitionAt).toISOString() : "",
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
