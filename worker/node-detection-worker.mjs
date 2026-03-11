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
const FACE_DESCRIPTOR_LENGTH = 128;

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

function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const v = line.trim();
    if (!v || v.startsWith("#")) continue;
    const eq = v.indexOf("=");
    if (eq <= 0) continue;
    const key = v.slice(0, eq).trim();
    const val = stripQuotes(v.slice(eq + 1));
    if (!key) continue;
    if (override || process.env[key] == null) process.env[key] = val;
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

function normalizeDescriptor(value) {
  if (!Array.isArray(value) || value.length !== FACE_DESCRIPTOR_LENGTH) return null;
  const descriptor = value.map((item) => Number(item));
  if (descriptor.some((item) => !Number.isFinite(item))) return null;
  return descriptor;
}

function descriptorToArray(value) {
  if (!value || typeof value !== "object") return null;
  const raw = Array.from(value, (item) => Number(item));
  return normalizeDescriptor(raw);
}

function isUnknownIdentity(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === "unknown" ||
    normalized === "unrecognized" ||
    normalized === "not_recognized" ||
    normalized === "undefined" ||
    normalized === "null" ||
    normalized === "none" ||
    normalized === "n/a"
  );
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

function parseWorkerZoomDefaults() {
  const raw = (process.env.WORKER_CAMERA_ZOOMS ?? "").trim();
  const map = {};
  if (!raw) return map;

  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const cameraId = entry.slice(0, eq).trim();
    const zoom = clampWorkerZoom(entry.slice(eq + 1).trim(), Number.NaN);
    if (!cameraId || !Number.isFinite(zoom)) continue;
    map[cameraId] = zoom;
  }

  return map;
}

function parseFiniteFloat(value, fallback = Number.NaN) {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFiniteInt(value, fallback = Number.NaN) {
  const parsed =
    typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCameraSettings() {
  const raw = (process.env.WORKER_CAMERA_SETTINGS_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    log(`camera settings parse error: ${String(err)}`);
    return {};
  }
}

function getCameraSetting(cameraSettings, cameraId, key, fallback) {
  const source = cameraSettings?.[cameraId];
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  if (!(key in source)) return fallback;
  return source[key];
}

function parseEmotionFromExpressions(expressions, keys) {
  if (!expressions) {
    return {
      key: "",
      confidence: 0,
      vector: {},
    };
  }

  const vector = {};
  let topKey = "";
  let topVal = -1;
  for (const k of keys) {
    const v = Number(expressions[k] ?? 0);
    const safe = Number.isFinite(v) ? Math.max(0, v) : 0;
    vector[k] = safe;
    if (safe > topVal) {
      topVal = safe;
      topKey = k;
    }
  }

  return {
    key: topKey,
    confidence: topVal > 0 ? topVal : 0,
    vector,
  };
}

function isImageFileName(fileName) {
  return /\.(jpe?g|png)$/i.test(fileName);
}

function sanitizeFileName(fileName) {
  return String(fileName || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
}

function computeDHash64FromRgb(rgb, width, height, hashSize = 8) {
  if (!(rgb instanceof Uint8Array) || width < 2 || height < 2) return null;
  const size = Math.max(4, Math.min(16, Math.trunc(hashSize)));
  const cols = size + 1;
  const rows = size;
  const gray = new Array(rows * cols);

  for (let y = 0; y < rows; y += 1) {
    const sy = Math.floor((y * (height - 1)) / Math.max(1, rows - 1));
    for (let x = 0; x < cols; x += 1) {
      const sx = Math.floor((x * (width - 1)) / Math.max(1, cols - 1));
      const idx = (sy * width + sx) * 3;
      const r = rgb[idx] ?? 0;
      const g = rgb[idx + 1] ?? 0;
      const b = rgb[idx + 2] ?? 0;
      gray[y * cols + x] = Math.floor((r * 30 + g * 59 + b * 11) / 100);
    }
  }

  let hash = 0n;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const left = gray[y * cols + x];
      const right = gray[y * cols + x + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

function hammingDistance64(left, right) {
  if (typeof left !== "bigint" || typeof right !== "bigint") return Number.POSITIVE_INFINITY;
  let value = left ^ right;
  let bits = 0;
  while (value > 0n) {
    bits += Number(value & 1n);
    value >>= 1n;
  }
  return bits;
}

function findClosestPhantomBaseline(baselines, rgb, width, height) {
  if (!Array.isArray(baselines) || !baselines.length) return null;
  const frameHash = computeDHash64FromRgb(rgb, width, height);
  if (frameHash == null) return null;

  let best = null;
  for (const baseline of baselines) {
    const distance = hammingDistance64(frameHash, baseline?.hash);
    if (!Number.isFinite(distance)) continue;
    if (!best || distance < best.distance) {
      best = {
        distance,
        baseline,
      };
    }
  }
  return best;
}

async function savePhantomSnapshot(snapshotDir, publicBase, cameraId, jpgBuffer, now) {
  if (!snapshotDir || !publicBase || !(jpgBuffer instanceof Buffer) || !jpgBuffer.length) return "";
  const safeCameraId = sanitizeFileName(cameraId || "cam");
  if (!safeCameraId) return "";
  const dirAbs = path.join(snapshotDir, safeCameraId);
  await fsp.mkdir(dirAbs, { recursive: true });
  const fileName = `${now}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await fsp.writeFile(path.join(dirAbs, fileName), jpgBuffer);
  return `${publicBase.replace(/\/+$/, "")}/${safeCameraId}/${fileName}`;
}

async function archiveFaceSnapshot({
  archiveDir,
  archivePublicBase,
  faceShortId,
  cameraId,
  jpgBuffer,
  now,
  maxPerFace = 50,
}) {
  if (!archiveDir || !archivePublicBase) return "";
  if (!(jpgBuffer instanceof Buffer) || !jpgBuffer.length) return "";
  const safeFaceId = sanitizeFileName(faceShortId || "").replace(/\./g, "_").slice(0, 32);
  if (!safeFaceId) return "";

  const faceDir = path.join(archiveDir, safeFaceId);
  await fsp.mkdir(faceDir, { recursive: true });

  const safeCameraId = sanitizeFileName(cameraId || "cam").slice(0, 24) || "cam";
  const fileName = `${now}-${safeCameraId}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fileAbs = path.join(faceDir, fileName);
  await fsp.writeFile(fileAbs, jpgBuffer);

  const keepLimit = Math.max(5, Number(maxPerFace) || 50);
  const entries = await fsp.readdir(faceDir, { withFileTypes: true }).catch(() => []);
  const images = entries.filter((entry) => entry?.isFile?.() && isImageFileName(entry.name));
  if (images.length > keepLimit) {
    const withTimes = await Promise.all(
      images.map(async (entry) => {
        const abs = path.join(faceDir, entry.name);
        const st = await fsp.stat(abs).catch(() => null);
        return st ? { name: entry.name, mtimeMs: st.mtimeMs } : null;
      }),
    );
    const sorted = withTimes
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = sorted.slice(keepLimit);
    await Promise.all(
      toDelete.map(async (item) =>
        fsp.rm(path.join(faceDir, item.name), { force: true }).catch(() => {}),
      ),
    );
  }

  return `${archivePublicBase.replace(/\/+$/, "")}/${safeFaceId}/${fileName}`;
}

async function loadPhantomBaselines({
  baselineDir,
  baselinePublicDir,
  baselinePublicBase,
  cameras,
}) {
  const out = new Map();
  for (const camera of cameras) {
    const cameraId = String(camera?.cameraId ?? "").trim();
    if (!cameraId) continue;
    const cameraDir = path.join(baselineDir, cameraId);
    let entries = [];
    try {
      entries = await fsp.readdir(cameraDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const rows = [];
    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      if (!isImageFileName(entry.name)) continue;
      const safeName = sanitizeFileName(entry.name);
      const sourceFile = path.join(cameraDir, entry.name);
      try {
        const fileBuffer = await fsp.readFile(sourceFile);
        const image = await loadImage(fileBuffer);
        const width = Number(image.width ?? 0);
        const height = Number(image.height ?? 0);
        if (!width || !height) continue;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, width, height);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const rgb = rgbaToRgbTensorData(rgba);
        const hash = computeDHash64FromRgb(rgb, width, height);
        if (hash == null) continue;

        let publicUrl = "";
        if (baselinePublicDir && baselinePublicBase) {
          const publicCameraDir = path.join(baselinePublicDir, cameraId);
          await fsp.mkdir(publicCameraDir, { recursive: true });
          const publicAbs = path.join(publicCameraDir, safeName);
          await fsp.writeFile(publicAbs, fileBuffer);
          publicUrl = `${baselinePublicBase.replace(/\/+$/, "")}/${cameraId}/${safeName}`;
        }

        rows.push({
          name: safeName,
          hash,
          publicUrl,
        });
      } catch (err) {
        log(`[phantom] baseline load failed camera=${cameraId} file=${entry.name} err=${String(err)}`);
      }
    }

    if (rows.length) {
      out.set(cameraId, rows);
    }
  }
  return out;
}

function createPresenceSession(now) {
  return {
    startedAt: now,
    lastSeenAt: now,
    lastSampleAt: 0,
    sampleCount: 0,
    emotionSampleCount: 0,
    bestDistance: Number.POSITIVE_INFINITY,
    emittedAt: 0,
    lastMoodLabel: "",
    emotionStats: new Map(),
  };
}

function addSessionEmotionSample(session, emotionKey, emotionConfidence) {
  const key = String(emotionKey ?? "").trim().toLowerCase();
  const confidence = Number(emotionConfidence ?? 0);
  if (!key || !Number.isFinite(confidence) || confidence <= 0) return;
  const prev = session.emotionStats.get(key) || { sum: 0, count: 0, max: 0 };
  prev.sum += confidence;
  prev.count += 1;
  prev.max = Math.max(prev.max, confidence);
  session.emotionStats.set(key, prev);
  session.emotionSampleCount += 1;
}

function resolveSessionEmotionLabel({
  session,
  minConfidence,
  lowConfidenceFloor,
  allowLowConfidenceLabel,
  allowFallbackMood,
  fallbackMood,
}) {
  let bestKey = "";
  let bestSum = 0;
  let bestAvg = 0;
  let bestPeak = 0;
  for (const [key, stats] of session.emotionStats.entries()) {
    const sum = Number(stats?.sum ?? 0);
    const count = Number(stats?.count ?? 0);
    const peak = Number(stats?.max ?? 0);
    if (!count || !Number.isFinite(sum)) continue;
    if (sum > bestSum) {
      bestSum = sum;
      bestKey = key;
      bestAvg = sum / count;
      bestPeak = Number.isFinite(peak) ? peak : bestAvg;
    }
  }

  if (bestKey) {
    const aggregatedConfidence = Math.max(bestAvg, bestPeak);
    if (aggregatedConfidence >= minConfidence) {
      return {
        moodLabel: bestKey,
        emotionLabel: `${bestKey} ${(aggregatedConfidence * 100).toFixed(0)}%`,
        emotionConfidence: Number(aggregatedConfidence.toFixed(4)),
      };
    }
    if (allowLowConfidenceLabel && aggregatedConfidence >= lowConfidenceFloor) {
      return {
        moodLabel: bestKey,
        emotionLabel: `${bestKey} ${(aggregatedConfidence * 100).toFixed(0)}%`,
        emotionConfidence: Number(aggregatedConfidence.toFixed(4)),
      };
    }
  }

  if (allowFallbackMood) {
    return {
      moodLabel: fallbackMood,
      emotionLabel: "",
      emotionConfidence: 0,
    };
  }

  return {
    moodLabel: "",
    emotionLabel: "",
    emotionConfidence: 0,
  };
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

function getLandmarkCenter(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const point of points) {
    const x = Number(point?.x ?? point?._x);
    const y = Number(point?.y ?? point?._y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x;
    sy += y;
    count += 1;
  }
  if (!count) return null;
  return { x: sx / count, y: sy / count };
}

function isLikelyFrontalFace(
  det,
  {
    enabled = true,
    minEyeDistanceRatio = 0.16,
    maxEyeSlope = 0.2,
    noseCenterTolerance = 0.3,
  } = {},
) {
  if (!enabled) return true;
  const box = getBox(det);
  if (!box) return false;
  const landmarks = det?.landmarks;
  if (!landmarks?.getLeftEye || !landmarks?.getRightEye || !landmarks?.getNose) {
    return false;
  }

  const leftEye = getLandmarkCenter(landmarks.getLeftEye());
  const rightEye = getLandmarkCenter(landmarks.getRightEye());
  const nose = getLandmarkCenter(landmarks.getNose());
  if (!leftEye || !rightEye || !nose) return false;

  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const eyeDist = Math.hypot(eyeDx, eyeDy);
  const eyeDistRatio = eyeDist / Math.max(1, box.width);
  if (eyeDistRatio < minEyeDistanceRatio) return false;

  const eyeSlope = Math.abs(eyeDy) / Math.max(1e-6, eyeDist);
  if (eyeSlope > maxEyeSlope) return false;

  const eyeLeftX = Math.min(leftEye.x, rightEye.x);
  const eyeRightX = Math.max(leftEye.x, rightEye.x);
  const noseBetweenEyes = (nose.x - eyeLeftX) / Math.max(1e-6, eyeRightX - eyeLeftX);
  if (noseBetweenEyes < 0.1 || noseBetweenEyes > 0.9) return false;

  const centerX = box.x + box.width / 2;
  const noseCenterOffset = Math.abs((nose.x - centerX) / Math.max(1, box.width));
  if (noseCenterOffset > noseCenterTolerance) return false;

  return true;
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

function upsertKnownDescriptor(labeledDescriptors, label, descriptor) {
  const safeLabel = String(label ?? "").trim();
  const safeDescriptor = normalizeDescriptor(descriptor);
  if (!safeLabel || !safeDescriptor) return false;

  const index = labeledDescriptors.findIndex((item) => String(item?.label ?? "") === safeLabel);
  if (index >= 0) {
    labeledDescriptors[index] = { label: safeLabel, descriptors: [safeDescriptor] };
    return false;
  }

  labeledDescriptors.push({ label: safeLabel, descriptors: [safeDescriptor] });
  return true;
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

function clampWorkerZoom(value, fallback = 1) {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(5, Math.max(1, Number(parsed.toFixed(2))));
}

async function readWorkerZoomState(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function fetchFrame(frameUrl, timeoutMs) {
  const url = new URL(frameUrl);
  url.searchParams.set("t", String(Date.now()));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
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

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`db_http_${res.status}${body ? ` body=${body.slice(0, 180)}` : ""}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function getJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`http_${res.status}${body ? ` body=${body.slice(0, 180)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function postJsonExpectJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`http_${res.status}${body ? ` body=${body.slice(0, 180)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function isAbortError(err) {
  const message = String(err ?? "");
  return (
    message.includes("AbortError") ||
    message.includes("operation was aborted") ||
    message.includes("aborted")
  );
}

function buildAbortFallbackFrameUrl(frameUrl, width, height, quality, timeoutMs = Number.NaN) {
  const url = new URL(frameUrl);
  if (Number.isFinite(width) && width > 0) {
    url.searchParams.set("width", String(Math.floor(width)));
  }
  if (Number.isFinite(height) && height > 0) {
    url.searchParams.set("height", String(Math.floor(height)));
  }
  if (Number.isFinite(quality) && quality > 0) {
    url.searchParams.set("quality", String(Math.floor(quality)));
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    url.searchParams.set("timeoutMs", String(Math.floor(timeoutMs)));
  }
  return url.toString();
}

function createDbQueueItem(payload, now) {
  return {
    payload,
    attempts: 0,
    nextAttemptAt: now,
  };
}

async function drainDbQueue({
  queue,
  now,
  maxBatchSize,
  dbEndpoint,
  requestTimeoutMs,
  maxAttempts,
  retryBaseMs,
  logPrefix = "db",
}) {
  if (!queue.length) return { sent: 0, failed: 0, delayed: 0 };

  const due = [];
  for (let i = 0; i < queue.length && due.length < maxBatchSize; ) {
    if ((queue[i]?.nextAttemptAt ?? 0) <= now) {
      due.push(queue.splice(i, 1)[0]);
      continue;
    }
    i += 1;
  }

  if (!due.length) return { sent: 0, failed: 0, delayed: 0 };

  let sent = 0;
  let failed = 0;
  let delayed = 0;

  await Promise.all(
    due.map(async (item) => {
      try {
        await postJsonWithTimeout(dbEndpoint, item.payload, requestTimeoutMs);
        sent += 1;
      } catch (err) {
        item.attempts += 1;
        if (item.attempts >= maxAttempts) {
          failed += 1;
          log(`[${logPrefix}] drop after ${item.attempts} attempts: ${String(err)}`);
          return;
        }

        const backoff = retryBaseMs * Math.pow(2, Math.max(0, item.attempts - 1));
        item.nextAttemptAt = now + backoff;
        queue.push(item);
        delayed += 1;
      }
    }),
  );

  return { sent, failed, delayed };
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
    workerZoom: 1,
    candidate: 0,
    confirmed: 0,
    score: 0,
    maxFaceSide: 0,
    motion: 0,
    streak: 0,
    matchedNames: [],
    matchDistance: 0,
    people: [],
    emotionSummary: "",
    topEmotion: "",
    snapshotUrl: "",
    frameOk: false,
    lastFrameAt: 0,
    lastFrameBytes: 0,
    lastFrameWidth: 0,
    lastFrameHeight: 0,
    workerFrameWidth: 0,
    workerFrameHeight: 0,
    lastFrameError: "",
    lastRecognitionAt: 0,
    lastConfirmedAt: 0,
    lastMatchAt: 0,
    lastSnapshotAt: 0,
    lastSnapshotSavedAt: 0,
    lastEmotionAt: 0,
    lastBestBox: null,
    prevLuma: null,
    emotionEmaByName: new Map(),
    emotionSeenAtByName: new Map(),
    lastCandidateLogAt: 0,
    lastConfirmLogAt: 0,
    lastMatchLogAt: 0,
    lastEmotionLogAt: 0,
    lastErrLogAt: 0,
    lastPhantomLogAt: 0,
    newIdGateDescriptor: null,
    newIdGateStreak: 0,
    newIdGateLastAt: 0,
    lastDbSentAt: new Map(),
    lastSeenMatchedAt: new Map(),
    lastFaceArchiveAtByName: new Map(),
    presenceSessions: new Map(),
    identityLockName: "",
    identityLockDistance: 0,
    identityLockUntil: 0,
  };
}

function buildFrameUrl(frameApiBase, src, timeoutMs = Number.NaN) {
  const url = new URL(frameApiBase);
  url.searchParams.set("src", src);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    url.searchParams.set("timeoutMs", String(Math.floor(timeoutMs)));
  }
  return url.toString();
}

async function main() {
  // Worker-local config must win over stale PM2 env values.
  loadEnvFile(path.join(rootDir, ".env.worker"), { override: true });
  loadEnvFile(path.join(rootDir, ".env"));

  const cameras = parseCameraSources();
  if (!cameras.length) {
    log("no cameras configured (set WORKER_CAMERA_SOURCES or NEXT_PUBLIC_CAMERA_*_GO2RTC_SRC)");
    process.exit(1);
  }

  const statusFile = process.env.WORKER_STATUS_FILE || "/tmp/mood-checker-worker-status.json";
  const statusDir = path.dirname(statusFile);
  await fsp.mkdir(statusDir, { recursive: true }).catch(() => {});
  const workerZoomStateFile = process.env.WORKER_ZOOM_STATE_FILE || "/tmp/mood-checker-worker-zoom.json";
  const workerZoomStateDir = path.dirname(workerZoomStateFile);
  await fsp.mkdir(workerZoomStateDir, { recursive: true }).catch(() => {});

  const frameApiBase =
    (process.env.WORKER_FRAME_API_BASE || "http://127.0.0.1:3000/api/camera/frame").replace(/\/+$/, "");
  const frameTimeoutMs = Math.max(500, envInt("WORKER_FRAME_TIMEOUT_MS", 1200));
  const frameAbortRetryEnabled = envBool("WORKER_FRAME_ABORT_RETRY_ENABLED", true);
  const frameAbortRetryTimeoutMs = Math.max(500, envInt("WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", 2500));
  const frameAbortRetryWidth = Math.max(320, envInt("WORKER_FRAME_ABORT_RETRY_WIDTH", 1280));
  const frameAbortRetryHeight = Math.max(180, envInt("WORKER_FRAME_ABORT_RETRY_HEIGHT", 720));
  const frameAbortRetryQuality = Math.min(100, Math.max(1, envInt("WORKER_FRAME_ABORT_RETRY_QUALITY", 85)));
  const frameApiTimeoutMs = Math.max(300, frameTimeoutMs - 300);
  const frameAbortRetryApiTimeoutMs = Math.max(500, frameAbortRetryTimeoutMs - 300);
  const loopDelayMs = Math.max(15, envInt("WORKER_LOOP_DELAY_MS", 50));
  const heartbeatSeconds = Math.max(1, envFloat("WORKER_HEARTBEAT_SECONDS", 5));
  const statusLogSeconds = Math.max(0.4, envFloat("WORKER_STATUS_LOG_SECONDS", 1.5));
  const detectionLogCooldownMs = Math.max(200, envInt("WORKER_DETECTION_LOG_COOLDOWN_MS", 500));
  const candidateLogCooldownMs = Math.max(200, envInt("WORKER_CANDIDATE_LOG_COOLDOWN_MS", 700));
  const confirmFrames = Math.max(1, envInt("WORKER_CONFIRM_FRAMES", 1));
  const motionThreshold = envFloat("WORKER_MOTION_THRESHOLD", 1.5);
  const minConfirmScore = envFloat("WORKER_MIN_CONFIRM_SCORE", 0.14);
  const personMinScore = envFloat(
    "WORKER_PERSON_MIN_SCORE",
    Math.max(minConfirmScore, 0.22),
  );
  const personMinSidePx = Math.max(10, envInt("WORKER_PERSON_MIN_SIDE_PX", 34));
  const personMinStreak = Math.max(1, envInt("WORKER_PERSON_MIN_STREAK", 2));
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
  const identityMinScore = Math.max(
    0,
    Math.min(1, envFloat("WORKER_IDENTITY_MIN_SCORE", 0.12)),
  );
  const identityLockMs = Math.max(0, envInt("WORKER_IDENTITY_LOCK_MS", 900));
  const identityLockSwitchMargin = Math.max(
    0,
    envFloat("WORKER_IDENTITY_LOCK_SWITCH_MARGIN", 0.02),
  );
  const requireFrontalFace = envBool("WORKER_REQUIRE_FRONTAL_FACE", true);
  const frontalMinEyeDistanceRatio = Math.max(
    0.05,
    envFloat("WORKER_FRONTAL_MIN_EYE_DISTANCE_RATIO", 0.12),
  );
  const frontalMaxEyeSlope = Math.max(0.02, envFloat("WORKER_FRONTAL_MAX_EYE_SLOPE", 0.2));
  const frontalNoseCenterTolerance = Math.max(
    0.05,
    envFloat("WORKER_FRONTAL_NOSE_CENTER_TOLERANCE", 0.42),
  );
  const matchIntervalMs = Math.max(120, envInt("WORKER_MATCH_INTERVAL_MS", 140));
  const matchLogCooldownMs = Math.max(300, envInt("WORKER_MATCH_LOG_COOLDOWN_MS", 1000));
  const enableEmotions = envBool("WORKER_ENABLE_EMOTIONS", true);
  const emotionIntervalMs = Math.max(150, envInt("WORKER_EMOTION_INTERVAL_MS", 300));
  const snapshotCooldownMs = Math.max(150, envInt("WORKER_SNAPSHOT_COOLDOWN_MS", 300));
  const recognitionHoldMs = Math.max(0, envInt("WORKER_RECOGNITION_HOLD_MS", 1200));
  const sessionSnapshotIntervalMs = Math.max(
    500,
    envInt("WORKER_SESSION_SNAPSHOT_INTERVAL_MS", 900),
  );
  const sessionAbsenceMs = Math.max(
    700,
    envInt("WORKER_SESSION_ABSENCE_MS", Math.max(2200, recognitionHoldMs + 800)),
  );
  const sessionResolveWaitMs = Math.max(
    300,
    envInt("WORKER_SESSION_RESOLVE_WAIT_MS", 1800),
  );
  const sessionMinSamples = Math.max(1, envInt("WORKER_SESSION_MIN_SAMPLES", 2));
  const sessionMinEmotionSamples = Math.max(
    1,
    envInt("WORKER_SESSION_MIN_EMOTION_SAMPLES", 2),
  );
  const workerZoomReloadMs = Math.max(250, envInt("WORKER_ZOOM_RELOAD_MS", 700));
  const workerZoomDefaults = parseWorkerZoomDefaults();
  const cameraSettings = parseCameraSettings();
  const parallelCameraLimit = Math.max(
    1,
    envInt("WORKER_PARALLEL_CAMERAS", Math.max(1, cameras.length)),
  );
  const emotionMinConfidence = Math.max(
    0,
    Math.min(1, envFloat("WORKER_EMOTION_MIN_CONFIDENCE", 0.45)),
  );
  const emotionLowConfidenceFloor = Math.max(
    0,
    Math.min(1, envFloat("WORKER_EMOTION_LOW_CONFIDENCE_FLOOR", 0.18)),
  );
  const emotionAllowLowConfidenceLabel = envBool(
    "WORKER_EMOTION_ALLOW_LOW_CONFIDENCE_LABEL",
    true,
  );
  const emotionEmaAlpha = Math.max(0, Math.min(1, envFloat("WORKER_EMOTION_EMA_ALPHA", 0.65)));
  const emotionEmaTtlMs = Math.max(2000, envInt("WORKER_EMOTION_EMA_TTL_MS", 12000));
  const dbEndpoint = (process.env.WORKER_DB_ENDPOINT || "http://127.0.0.1:3000/api/recognitions").trim();
  const dbCooldownMs = Math.max(1000, envInt("WORKER_DB_COOLDOWN_MS", 4000));
  const dbReentryGapMs = Math.max(300, envInt("WORKER_DB_REENTRY_GAP_MS", 1800));
  const dbSeenTtlMs = Math.max(dbCooldownMs * 6, dbReentryGapMs * 6);
  const dbAllowMoodFallback = envBool("WORKER_DB_ALLOW_MOOD_FALLBACK", true);
  const dbFallbackMoodRaw = (process.env.WORKER_DB_FALLBACK_MOOD || "neutral").trim().toLowerCase();
  const dbFallbackMood = dbFallbackMoodRaw || "neutral";
  const dbRequestTimeoutMs = Math.max(500, envInt("WORKER_DB_TIMEOUT_MS", 1500));
  const dbQueueMaxSize = Math.max(10, envInt("WORKER_DB_QUEUE_MAX_SIZE", 300));
  const dbQueueBatchSize = Math.max(1, envInt("WORKER_DB_QUEUE_BATCH_SIZE", 6));
  const dbQueueMaxAttempts = Math.max(1, envInt("WORKER_DB_QUEUE_MAX_ATTEMPTS", 4));
  const dbQueueRetryBaseMs = Math.max(200, envInt("WORKER_DB_QUEUE_RETRY_BASE_MS", 1000));
  const dbQueueWarnAt = Math.max(5, envInt("WORKER_DB_QUEUE_WARN_AT", 60));
  const saveSnapshots = envBool("WORKER_SAVE_SNAPSHOTS", true);
  const snapshotSaveCooldownMs = Math.max(200, envInt("WORKER_SNAPSHOT_SAVE_COOLDOWN_MS", 500));
  const snapshotDir = process.env.WORKER_SNAPSHOT_DIR || path.join(rootDir, "public", "_worker-snaps");
  const snapshotPublicBase = (process.env.WORKER_SNAPSHOT_PUBLIC_BASE || "/_worker-snaps").replace(
    /\/+$/,
    "",
  );
  const faceRegistryEndpoint = (
    process.env.WORKER_FACE_REGISTRY_ENDPOINT || "http://127.0.0.1:3000/api/faces/registry"
  ).trim();
  const faceIdentifyEndpoint = (
    process.env.WORKER_FACE_IDENTIFY_ENDPOINT || "http://127.0.0.1:3000/api/faces/identify"
  ).trim();
  const faceRegistryTimeoutMs = Math.max(500, envInt("WORKER_FACE_REGISTRY_TIMEOUT_MS", 2000));
  const faceIdentifyTimeoutMs = Math.max(500, envInt("WORKER_FACE_IDENTIFY_TIMEOUT_MS", 2000));
  const faceRegistryRefreshMs = Math.max(3000, envInt("WORKER_FACE_REGISTRY_REFRESH_MS", 20000));
  const faceAutoCreate = envBool("WORKER_FACE_AUTO_CREATE", true);
  const newIdConfirmFrames = Math.max(1, envInt("WORKER_NEW_ID_CONFIRM_FRAMES", 2));
  const newIdMinScore = Math.max(0, Math.min(1, envFloat("WORKER_NEW_ID_MIN_SCORE", 0.18)));
  const newIdMinFaceSidePx = Math.max(8, envInt("WORKER_NEW_ID_MIN_FACE_SIDE_PX", 28));
  const newIdStabilityMaxDistance = Math.max(
    0.01,
    Math.min(2, envFloat("WORKER_NEW_ID_STABILITY_MAX_DISTANCE", 0.34)),
  );
  const newIdMaxGapMs = Math.max(120, envInt("WORKER_NEW_ID_MAX_GAP_MS", 1200));
  const faceArchiveEnabled = envBool("WORKER_FACE_ARCHIVE_ENABLED", true);
  const faceArchiveCooldownMs = Math.max(500, envInt("WORKER_FACE_ARCHIVE_COOLDOWN_MS", 2500));
  const faceArchiveMaxPerFace = Math.max(5, envInt("WORKER_FACE_ARCHIVE_MAX_PER_FACE", 50));
  const faceArchiveDir = process.env.WORKER_FACE_ARCHIVE_DIR || path.join(rootDir, "public", "_faces");
  const faceArchivePublicBase = (process.env.WORKER_FACE_ARCHIVE_PUBLIC_BASE || "/_faces").replace(
    /\/+$/,
    "",
  );
  const phantomGuardEnabled = envBool("WORKER_PHANTOM_GUARD_ENABLED", true);
  const phantomBaselineDir =
    process.env.WORKER_PHANTOM_BASELINE_DIR || path.join(rootDir, "worker", "phantom-baselines");
  const phantomBaselinePublicDir =
    process.env.WORKER_PHANTOM_BASELINE_PUBLIC_DIR ||
    path.join(rootDir, "public", "_phantom-baselines");
  const phantomBaselinePublicBase = (
    process.env.WORKER_PHANTOM_BASELINE_PUBLIC_BASE || "/_phantom-baselines"
  ).replace(/\/+$/, "");
  const phantomHashDistanceMax = Math.max(0, envInt("WORKER_PHANTOM_HASH_DISTANCE_MAX", 10));
  const phantomLogEndpoint =
    (process.env.WORKER_PHANTOM_LOG_ENDPOINT || "http://127.0.0.1:3000/api/faces/dedup-logs").trim();
  const phantomLogTimeoutMs = Math.max(400, envInt("WORKER_PHANTOM_LOG_TIMEOUT_MS", 1200));
  const phantomLogCooldownMs = Math.max(1000, envInt("WORKER_PHANTOM_LOG_COOLDOWN_MS", 9000));
  const phantomSnapshotDir =
    process.env.WORKER_PHANTOM_SNAPSHOT_DIR || path.join(rootDir, "public", "_phantom-rejects");
  const phantomSnapshotPublicBase = (
    process.env.WORKER_PHANTOM_SNAPSHOT_PUBLIC_BASE || "/_phantom-rejects"
  ).replace(/\/+$/, "");

  if (saveSnapshots) {
    await fsp.mkdir(snapshotDir, { recursive: true }).catch(() => {});
  }
  if (faceArchiveEnabled) {
    await fsp.mkdir(faceArchiveDir, { recursive: true }).catch(() => {});
  }
  if (phantomGuardEnabled) {
    await fsp.mkdir(phantomSnapshotDir, { recursive: true }).catch(() => {});
    await fsp.mkdir(phantomBaselinePublicDir, { recursive: true }).catch(() => {});
  }

  const modelDir = path.join(rootDir, "public", "models");
  if (!fs.existsSync(modelDir)) {
    log(`model dir not found: ${modelDir}`);
    process.exit(1);
  }

  faceapi.tf.enableProdMode();
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
  let knownLabeledDescriptors = [];
  let lastFaceRegistryReloadAt = 0;
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
  const phantomBaselinesByCamera = phantomGuardEnabled
    ? await loadPhantomBaselines({
        baselineDir: phantomBaselineDir,
        baselinePublicDir: phantomBaselinePublicDir,
        baselinePublicBase: phantomBaselinePublicBase,
        cameras,
      })
    : new Map();

  const reloadFaceRegistry = async (reason) => {
    const loadedAt = Date.now();
    if (!faceRegistryEndpoint) return;
    try {
      const payload = await getJsonWithTimeout(faceRegistryEndpoint, faceRegistryTimeoutMs);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const nextDescriptors = [];
      for (const item of items) {
        const label = String(item?.shortId ?? "").trim();
        const descriptor = normalizeDescriptor(item?.descriptor);
        if (!label || !descriptor) continue;
        nextDescriptors.push({ label, descriptors: [descriptor] });
      }
      knownLabeledDescriptors = nextDescriptors;
      lastFaceRegistryReloadAt = loadedAt;
      if (reason) {
        log(`[faces] registry reload reason=${reason} count=${knownLabeledDescriptors.length}`);
      }
    } catch (err) {
      if (reason) {
        log(`[faces] registry reload failed reason=${reason} err=${String(err)}`);
      }
    }
  };

  let lastIdentifyErrLogAt = 0;
  const identifyFaceDescriptor = async (
    descriptor,
    threshold,
    snapshotBase64 = "",
  ) => {
    if (!faceIdentifyEndpoint || !faceAutoCreate) return null;
    const safeDescriptor = normalizeDescriptor(descriptor);
    if (!safeDescriptor) return null;
    try {
      const payloadBody = {
        descriptor: safeDescriptor,
        threshold,
        snapshotBase64: typeof snapshotBase64 === "string" ? snapshotBase64 : "",
      };
      const payload = await postJsonExpectJsonWithTimeout(
        faceIdentifyEndpoint,
        payloadBody,
        faceIdentifyTimeoutMs,
      );
      const shortId = String(payload?.shortId ?? "").trim();
      const mergedDescriptor = normalizeDescriptor(payload?.descriptor) || safeDescriptor;
      if (!shortId || !mergedDescriptor) return null;
      upsertKnownDescriptor(knownLabeledDescriptors, shortId, mergedDescriptor);
      return {
        shortId,
        distance: Number(payload?.distance),
        created: Boolean(payload?.created),
      };
    } catch (err) {
      const now = Date.now();
      if (now - lastIdentifyErrLogAt >= 3000) {
        log(`[faces] identify failed err=${String(err)}`);
        lastIdentifyErrLogAt = now;
      }
      return null;
    }
  };
  let lastPhantomErrLogAt = 0;
  const writePhantomRejectionLog = async ({
    cameraId,
    action,
    reason,
    sourceSnapshotUrl = "",
    targetSnapshotUrl = "",
    targetShortId = "",
    distance = Number.NaN,
    threshold = Number.NaN,
  }) => {
    if (!phantomLogEndpoint || !reason) return;
    try {
      await postJsonWithTimeout(
        phantomLogEndpoint,
        {
          action,
          reason,
          sourceShortId: cameraId || null,
          targetShortId: targetShortId || null,
          sourceSnapshotUrl: sourceSnapshotUrl || null,
          targetSnapshotUrl: targetSnapshotUrl || null,
          distance: Number.isFinite(distance) ? Number(distance.toFixed(6)) : null,
          threshold: Number.isFinite(threshold) ? Number(threshold.toFixed(6)) : null,
        },
        phantomLogTimeoutMs,
      );
    } catch (err) {
      const now = Date.now();
      if (now - lastPhantomErrLogAt >= 3000) {
        log(`[phantom] log write failed err=${String(err)}`);
        lastPhantomErrLogAt = now;
      }
    }
  };

  if (enableMatching) {
    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(modelDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
    await reloadFaceRegistry("startup");
    log(
      `matching=on known=${knownLabeledDescriptors.length} threshold=${matchThreshold} ` +
        `min_margin=${matchMinMargin} min_face_px=${matchMinFaceSidePx} auto_create=${faceAutoCreate ? "on" : "off"} ` +
        `new_id_frames=${newIdConfirmFrames} new_id_min_score=${newIdMinScore.toFixed(3)} ` +
        `new_id_min_side=${newIdMinFaceSidePx} archive=${faceArchiveEnabled ? "on" : "off"}`,
    );
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

  const states = cameras.map((c) => {
    const state = createState(c.cameraId, c.src);
    // Apply defaults once on startup; after that keep current zoom unless explicit override exists.
    state.workerZoom = clampWorkerZoom(workerZoomDefaults[c.cameraId] ?? 1, 1);
    return state;
  });
  if (phantomGuardEnabled) {
    const baselineSummary = states
      .map((cam) => `${cam.cameraId}:${(phantomBaselinesByCamera.get(cam.cameraId) || []).length}`)
      .join(", ");
    log(
      `phantom_guard=on hash_max=${phantomHashDistanceMax} cooldown_ms=${phantomLogCooldownMs} ` +
        `baselines=[${baselineSummary || "none"}]`,
    );
  } else {
    log("phantom_guard=off");
  }
  log(`started cameras=${states.length} frame_api=${frameApiBase}`);
  log(
    `pipeline parallel_cameras=${parallelCameraLimit} db_queue_max=${dbQueueMaxSize} ` +
      `db_batch=${dbQueueBatchSize} db_timeout_ms=${dbRequestTimeoutMs}`,
  );
  log(
    `emotion min_confidence=${emotionMinConfidence} ema_alpha=${emotionEmaAlpha} ` +
      `ema_ttl_ms=${emotionEmaTtlMs} low_floor=${emotionLowConfidenceFloor} ` +
      `allow_low_label=${emotionAllowLowConfidenceLabel ? "on" : "off"}`,
  );
  log(
    `db cooldown_ms=${dbCooldownMs} reentry_gap_ms=${dbReentryGapMs} ` +
      `mood_fallback=${dbAllowMoodFallback ? dbFallbackMood : "off"}`,
  );
  log(
    `faces registry=${faceRegistryEndpoint || "off"} identify=${faceIdentifyEndpoint || "off"} ` +
      `refresh_ms=${faceRegistryRefreshMs} include_snapshot=on`,
  );
  log(
    `session snapshot_ms=${sessionSnapshotIntervalMs} absence_ms=${sessionAbsenceMs} ` +
      `resolve_wait_ms=${sessionResolveWaitMs} min_samples=${sessionMinSamples} ` +
      `min_emotion_samples=${sessionMinEmotionSamples}`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastHeartbeatAt = 0;
  let lastStatusAt = 0;
  let lastZoomReloadAt = 0;
  let workerZoomMap = {};
  const dbQueue = [];
  let lastDbQueueWarnAt = 0;
  let lastLoopErrLogAt = 0;
  const emotionKeys = ["happy", "sad", "angry", "fearful", "disgusted", "surprised"];
  const loggedCameraProfiles = new Set();

  const processCamera = async (cam, now) => {
    const camFilterMinScore = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMinScore", filterMinScore),
        filterMinScore,
      ),
    );
    const camFilterMinSidePx = Math.max(
      4,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMinSidePx", filterMinSidePx),
        filterMinSidePx,
      ),
    );
    const camFilterMinSideRatio = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMinSideRatio", filterMinSideRatio),
        filterMinSideRatio,
      ),
    );
    const camFilterMinAreaRatio = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMinAreaRatio", filterMinAreaRatio),
        filterMinAreaRatio,
      ),
    );
    const camFilterMaxAreaRatio = Math.max(
      camFilterMinAreaRatio,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMaxAreaRatio", filterMaxAreaRatio),
        filterMaxAreaRatio,
      ),
    );
    const camFilterMinAspect = Math.max(
      0.1,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMinAspect", filterMinAspect),
        filterMinAspect,
      ),
    );
    const camFilterMaxAspect = Math.max(
      camFilterMinAspect,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "filterMaxAspect", filterMaxAspect),
        filterMaxAspect,
      ),
    );

    const camConfirmFrames = Math.max(
      1,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "confirmFrames", confirmFrames),
        confirmFrames,
      ),
    );
    const camMotionThreshold = parseFiniteFloat(
      getCameraSetting(cameraSettings, cam.cameraId, "motionThreshold", motionThreshold),
      motionThreshold,
    );
    const camMinConfirmScore = parseFiniteFloat(
      getCameraSetting(cameraSettings, cam.cameraId, "minConfirmScore", minConfirmScore),
      minConfirmScore,
    );
    const camPersonMinScore = parseFiniteFloat(
      getCameraSetting(cameraSettings, cam.cameraId, "personMinScore", personMinScore),
      personMinScore,
    );
    const camPersonMinSidePx = Math.max(
      10,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "personMinSidePx", personMinSidePx),
        personMinSidePx,
      ),
    );
    const camPersonMinStreak = Math.max(
      1,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "personMinStreak", personMinStreak),
        personMinStreak,
      ),
    );
    const camMatchThreshold = parseFiniteFloat(
      getCameraSetting(cameraSettings, cam.cameraId, "matchThreshold", matchThreshold),
      matchThreshold,
    );
    const camMatchMinMargin = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "matchMinMargin", matchMinMargin),
        matchMinMargin,
      ),
    );
    const camMatchMinFaceSidePx = Math.max(
      0,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "matchMinFaceSidePx", matchMinFaceSidePx),
        matchMinFaceSidePx,
      ),
    );
    const camIdentityMinScore = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "identityMinScore", identityMinScore),
          identityMinScore,
        ),
      ),
    );
    const camIdentityLockMs = Math.max(
      0,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "identityLockMs", identityLockMs),
        identityLockMs,
      ),
    );
    const camIdentityLockSwitchMargin = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "identityLockSwitchMargin",
          identityLockSwitchMargin,
        ),
        identityLockSwitchMargin,
      ),
    );
    const camRequireFrontalFaceRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "requireFrontalFace",
      requireFrontalFace,
    );
    const camRequireFrontalFace =
      typeof camRequireFrontalFaceRaw === "boolean"
        ? camRequireFrontalFaceRaw
        : requireFrontalFace;
    const camFrontalMinEyeDistanceRatio = Math.max(
      0.05,
      parseFiniteFloat(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "frontalMinEyeDistanceRatio",
          frontalMinEyeDistanceRatio,
        ),
        frontalMinEyeDistanceRatio,
      ),
    );
    const camFrontalMaxEyeSlope = Math.max(
      0.02,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "frontalMaxEyeSlope", frontalMaxEyeSlope),
        frontalMaxEyeSlope,
      ),
    );
    const camFrontalNoseCenterTolerance = Math.max(
      0.05,
      parseFiniteFloat(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "frontalNoseCenterTolerance",
          frontalNoseCenterTolerance,
        ),
        frontalNoseCenterTolerance,
      ),
    );
    const camMatchIntervalMs = Math.max(
      120,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "matchIntervalMs", matchIntervalMs),
        matchIntervalMs,
      ),
    );
    const camEmotionIntervalMs = Math.max(
      150,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "emotionIntervalMs", emotionIntervalMs),
        emotionIntervalMs,
      ),
    );
    const camSnapshotCooldownMs = Math.max(
      120,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "snapshotCooldownMs", snapshotCooldownMs),
        snapshotCooldownMs,
      ),
    );
    const camRecognitionHoldMs = Math.max(
      0,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "recognitionHoldMs", recognitionHoldMs),
        recognitionHoldMs,
      ),
    );
    const camEmotionMinConfidence = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "emotionMinConfidence", emotionMinConfidence),
          emotionMinConfidence,
        ),
      ),
    );
    const camEmotionLowConfidenceFloor = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(
            cameraSettings,
            cam.cameraId,
            "emotionLowConfidenceFloor",
            emotionLowConfidenceFloor,
          ),
          emotionLowConfidenceFloor,
        ),
      ),
    );
    const camEmotionAllowLowConfidenceLabelRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "emotionAllowLowConfidenceLabel",
      emotionAllowLowConfidenceLabel,
    );
    const camEmotionAllowLowConfidenceLabel =
      typeof camEmotionAllowLowConfidenceLabelRaw === "boolean"
        ? camEmotionAllowLowConfidenceLabelRaw
        : emotionAllowLowConfidenceLabel;
    const camEmotionEmaAlpha = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "emotionEmaAlpha", emotionEmaAlpha),
          emotionEmaAlpha,
        ),
      ),
    );
    const camDbReentryGapMs = Math.max(
      300,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "dbReentryGapMs", dbReentryGapMs),
        dbReentryGapMs,
      ),
    );
    const camSessionSnapshotIntervalMs = Math.max(
      500,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "sessionSnapshotIntervalMs",
          sessionSnapshotIntervalMs,
        ),
        sessionSnapshotIntervalMs,
      ),
    );
    const camSessionAbsenceMs = Math.max(
      700,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "sessionAbsenceMs", sessionAbsenceMs),
        sessionAbsenceMs,
      ),
    );
    const camSessionResolveWaitMs = Math.max(
      300,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "sessionResolveWaitMs", sessionResolveWaitMs),
        sessionResolveWaitMs,
      ),
    );
    const camSessionMinSamples = Math.max(
      1,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "sessionMinSamples", sessionMinSamples),
        sessionMinSamples,
      ),
    );
    const camSessionMinEmotionSamples = Math.max(
      1,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "sessionMinEmotionSamples",
          sessionMinEmotionSamples,
        ),
        sessionMinEmotionSamples,
      ),
    );
    const camPhantomGuardEnabledRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "phantomGuardEnabled",
      phantomGuardEnabled,
    );
    const camPhantomGuardEnabled =
      typeof camPhantomGuardEnabledRaw === "boolean"
        ? camPhantomGuardEnabledRaw
        : phantomGuardEnabled;
    const camPhantomHashDistanceMax = Math.max(
      0,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "phantomHashDistanceMax",
          phantomHashDistanceMax,
        ),
        phantomHashDistanceMax,
      ),
    );
    const camPhantomLogCooldownMs = Math.max(
      1000,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "phantomLogCooldownMs", phantomLogCooldownMs),
        phantomLogCooldownMs,
      ),
    );
    const camNewIdConfirmFrames = Math.max(
      1,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "newIdConfirmFrames", newIdConfirmFrames),
        newIdConfirmFrames,
      ),
    );
    const camNewIdMinScore = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "newIdMinScore", newIdMinScore),
          newIdMinScore,
        ),
      ),
    );
    const camNewIdMinFaceSidePx = Math.max(
      8,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "newIdMinFaceSidePx", newIdMinFaceSidePx),
        newIdMinFaceSidePx,
      ),
    );
    const camNewIdStabilityMaxDistance = Math.max(
      0.01,
      Math.min(
        2,
        parseFiniteFloat(
          getCameraSetting(
            cameraSettings,
            cam.cameraId,
            "newIdStabilityMaxDistance",
            newIdStabilityMaxDistance,
          ),
          newIdStabilityMaxDistance,
        ),
      ),
    );
    const camNewIdMaxGapMs = Math.max(
      120,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "newIdMaxGapMs", newIdMaxGapMs),
        newIdMaxGapMs,
      ),
    );
    const camFaceArchiveEnabledRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "faceArchiveEnabled",
      faceArchiveEnabled,
    );
    const camFaceArchiveEnabled =
      typeof camFaceArchiveEnabledRaw === "boolean"
        ? camFaceArchiveEnabledRaw
        : faceArchiveEnabled;
    const camFaceArchiveCooldownMs = Math.max(
      500,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "faceArchiveCooldownMs",
          faceArchiveCooldownMs,
        ),
        faceArchiveCooldownMs,
      ),
    );
    const camFaceArchiveMaxPerFace = Math.max(
      5,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "faceArchiveMaxPerFace", faceArchiveMaxPerFace),
        faceArchiveMaxPerFace,
      ),
    );
    const camPhantomBaselines = phantomBaselinesByCamera.get(cam.cameraId) || [];
    const evictPresenceSessions = (activeNames = null) => {
      for (const [savedName, session] of cam.presenceSessions.entries()) {
        if (activeNames && activeNames.has(savedName)) continue;
        if (now - (session?.lastSeenAt ?? 0) <= camSessionAbsenceMs) continue;
        cam.presenceSessions.delete(savedName);
        cam.lastSeenMatchedAt.delete(savedName);
        cam.lastDbSentAt.delete(`${cam.cameraId}:${savedName}`);
      }
    };
    const resetNewIdGate = () => {
      cam.newIdGateDescriptor = null;
      cam.newIdGateStreak = 0;
      cam.newIdGateLastAt = 0;
    };
    const confirmNewIdCandidate = (descriptor, faceSide, identityScore) => {
      if (!faceAutoCreate || !Array.isArray(descriptor) || descriptor.length !== FACE_DESCRIPTOR_LENGTH) {
        resetNewIdGate();
        return false;
      }
      if (faceSide < camNewIdMinFaceSidePx || identityScore < camNewIdMinScore) {
        resetNewIdGate();
        return false;
      }

      const prevDescriptor = Array.isArray(cam.newIdGateDescriptor) ? cam.newIdGateDescriptor : null;
      const withinGap = now - (cam.newIdGateLastAt || 0) <= camNewIdMaxGapMs;
      const stableDistance =
        prevDescriptor && prevDescriptor.length === descriptor.length
          ? Number(faceapi.euclideanDistance(descriptor, prevDescriptor))
          : Number.POSITIVE_INFINITY;
      const isStable = withinGap && Number.isFinite(stableDistance) && stableDistance <= camNewIdStabilityMaxDistance;

      cam.newIdGateStreak = isStable ? cam.newIdGateStreak + 1 : 1;
      cam.newIdGateLastAt = now;
      cam.newIdGateDescriptor = descriptor.slice();
      return cam.newIdGateStreak >= camNewIdConfirmFrames;
    };
    const applyIdentityLock = (name, distance) => {
      const safeName = String(name || "").trim();
      const safeDistance = Number(distance) || 0;
      if (!safeName || isUnknownIdentity(safeName) || camIdentityLockMs <= 0) {
        return { name: safeName, distance: safeDistance, overridden: false };
      }

      const lockActive = cam.identityLockName && now < cam.identityLockUntil;
      if (lockActive && safeName !== cam.identityLockName) {
        const lockDistance = Number(cam.identityLockDistance) || 0;
        const incomingDistance = safeDistance;
        const incomingClearlyBetter =
          incomingDistance > 0 &&
          (lockDistance <= 0 || incomingDistance + camIdentityLockSwitchMargin < lockDistance);

        if (!incomingClearlyBetter) {
          return {
            name: cam.identityLockName,
            distance: lockDistance > 0 ? lockDistance : incomingDistance,
            overridden: true,
          };
        }
      }

      cam.identityLockName = safeName;
      if (safeDistance > 0) {
        cam.identityLockDistance = safeDistance;
      }
      cam.identityLockUntil = now + camIdentityLockMs;
      return { name: safeName, distance: safeDistance, overridden: false };
    };

    const frameUrl = buildFrameUrl(frameApiBase, cam.src, frameApiTimeoutMs);
    const zoomOverride = Number(workerZoomMap?.[cam.cameraId]);
    if (Number.isFinite(zoomOverride)) {
      cam.workerZoom = clampWorkerZoom(zoomOverride, cam.workerZoom);
    } else {
      cam.workerZoom = clampWorkerZoom(cam.workerZoom, 1);
    }
    if (!loggedCameraProfiles.has(cam.cameraId)) {
      loggedCameraProfiles.add(cam.cameraId);
      log(
        `[${cam.cameraId}] profile ` +
          `zoom=${cam.workerZoom.toFixed(2)} confirm_frames=${camConfirmFrames} ` +
          `min_confirm=${camMinConfirmScore.toFixed(3)} filter_min=${camFilterMinScore.toFixed(3)} ` +
          `person_min=${camPersonMinScore.toFixed(3)} person_side=${camPersonMinSidePx} ` +
          `person_streak=${camPersonMinStreak} match_th=${camMatchThreshold.toFixed(3)} ` +
          `match_margin=${camMatchMinMargin.toFixed(3)} match_face_px=${camMatchMinFaceSidePx} ` +
          `identity_min=${camIdentityMinScore.toFixed(3)} frontal=${camRequireFrontalFace ? "on" : "off"} ` +
          `new_id_frames=${camNewIdConfirmFrames} new_id_min=${camNewIdMinScore.toFixed(3)} ` +
          `new_id_side=${camNewIdMinFaceSidePx} new_id_stability=${camNewIdStabilityMaxDistance.toFixed(3)} ` +
          `lock_ms=${camIdentityLockMs} lock_margin=${camIdentityLockSwitchMargin.toFixed(3)} ` +
          `emotion_min=${camEmotionMinConfidence.toFixed(3)} emotion_floor=${camEmotionLowConfidenceFloor.toFixed(3)} ` +
          `db_reentry_ms=${camDbReentryGapMs} session_ms=${camSessionSnapshotIntervalMs} ` +
          `absence_ms=${camSessionAbsenceMs} resolve_ms=${camSessionResolveWaitMs} ` +
          `archive=${camFaceArchiveEnabled ? "on" : "off"} archive_cd=${camFaceArchiveCooldownMs} ` +
          `phantom=${camPhantomGuardEnabled && camPhantomBaselines.length ? "on" : "off"} ` +
          `phantom_base=${camPhantomBaselines.length} phantom_hash=${camPhantomHashDistanceMax}`,
      );
    }

    try {
      let jpg;
      try {
        jpg = await fetchFrame(frameUrl, frameTimeoutMs);
      } catch (err) {
        if (!frameAbortRetryEnabled || !isAbortError(err)) throw err;
        const retryUrl = buildAbortFallbackFrameUrl(
          frameUrl,
          frameAbortRetryWidth,
          frameAbortRetryHeight,
          frameAbortRetryQuality,
          frameAbortRetryApiTimeoutMs,
        );
        jpg = await fetchFrame(retryUrl, frameAbortRetryTimeoutMs);
      }
      const image = await loadImage(jpg);
      const sourceWidth = Number(image.width ?? 0);
      const sourceHeight = Number(image.height ?? 0);
      if (!sourceWidth || !sourceHeight) {
        throw new Error("invalid_image");
      }
      const workerWidth =
        cam.workerZoom > 1
          ? Math.max(64, Math.floor(sourceWidth / cam.workerZoom))
          : sourceWidth;
      const workerHeight =
        cam.workerZoom > 1
          ? Math.max(64, Math.floor(sourceHeight / cam.workerZoom))
          : sourceHeight;
      const cropX = Math.max(0, Math.floor((sourceWidth - workerWidth) / 2));
      const cropY = Math.max(0, Math.floor((sourceHeight - workerHeight) / 2));

      cam.frameOk = true;
      cam.lastFrameAt = now;
      cam.lastFrameBytes = jpg.byteLength;
      cam.lastFrameWidth = sourceWidth;
      cam.lastFrameHeight = sourceHeight;
      cam.workerFrameWidth = workerWidth;
      cam.workerFrameHeight = workerHeight;
      cam.lastFrameError = "";

      const canvas = createCanvas(workerWidth, workerHeight);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        image,
        cropX,
        cropY,
        workerWidth,
        workerHeight,
        0,
        0,
        workerWidth,
        workerHeight,
      );
      const rgba = ctx.getImageData(0, 0, workerWidth, workerHeight).data;
      const rgb = rgbaToRgbTensorData(rgba);
      const phantomSceneMatch =
        camPhantomGuardEnabled && camPhantomBaselines.length
          ? findClosestPhantomBaseline(camPhantomBaselines, rgb, workerWidth, workerHeight)
          : null;
      const sceneLooksEmpty =
        Boolean(phantomSceneMatch) &&
        Number(phantomSceneMatch.distance) <= camPhantomHashDistanceMax;
      const frameTensor = faceapi.tf.tensor3d(rgb, [workerHeight, workerWidth, 3], "int32");

      let detections = [];
      try {
        detections = await faceapi.detectAllFaces(frameTensor, tinyOptions);
        if (!detections.length && ssdLoaded) {
          detections = await faceapi.detectAllFaces(frameTensor, ssdOptions);
        }
      } finally {
        const resized = faceapi.tf.image.resizeBilinear(frameTensor, [54, 96], true);
        const downsampled = await resized.data();
        resized.dispose();
        frameTensor.dispose();

        const nextLuma = computeLumaBufferFromRgb(downsampled);
        cam.motion = computeMotionScore(cam.prevLuma, nextLuma);
        cam.prevLuma = nextLuma;
      }

      detections = filterAndDedupeDetections(detections, workerWidth, workerHeight, {
        minSidePxBase: camFilterMinSidePx,
        minSideRatio: camFilterMinSideRatio,
        minAreaRatio: camFilterMinAreaRatio,
        maxAreaRatio: camFilterMaxAreaRatio,
        minScore: camFilterMinScore,
        minAspect: camFilterMinAspect,
        maxAspect: camFilterMaxAspect,
      });
      if (sceneLooksEmpty && detections.length) {
        if (now - cam.lastPhantomLogAt >= camPhantomLogCooldownMs) {
          cam.lastPhantomLogAt = now;
          try {
            const sourceSnapshotUrl = await savePhantomSnapshot(
              phantomSnapshotDir,
              phantomSnapshotPublicBase,
              cam.cameraId,
              jpg,
              now,
            );
            await writePhantomRejectionLog({
              cameraId: cam.cameraId,
              action: "phantom_detection_blocked",
              reason: "Фантомная детекция заблокирована: кадр совпадает с пустой сценой.",
              sourceSnapshotUrl,
              targetSnapshotUrl: String(phantomSceneMatch?.baseline?.publicUrl ?? "").trim(),
              targetShortId: `baseline:${cam.cameraId}`,
              distance: Number(phantomSceneMatch?.distance ?? Number.NaN),
              threshold: camPhantomHashDistanceMax,
            });
          } catch (err) {
            if (now - cam.lastErrLogAt >= 2000) {
              log(`[${cam.cameraId}] phantom block log error: ${String(err)}`);
              cam.lastErrLogAt = now;
            }
          }
        }
        detections = [];
      }
      cam.candidate = detections.length;

      const { maxSide, maxScore } = largestFaceStats(detections);
      cam.score = maxScore;
      cam.maxFaceSide = maxSide;

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
        cam.motion >= camMotionThreshold || recentConfirm || maxScore >= 0.65 || maxSide >= 150;
      const isConfirmed =
        cam.candidate > 0 &&
        cam.streak >= camConfirmFrames &&
        maxScore >= camMinConfirmScore &&
        (fastPassMode ? true : motionGate);
      cam.confirmed = isConfirmed ? cam.candidate : 0;
      if (!isConfirmed) {
        cam.matchedNames = [];
        cam.matchDistance = 0;
        cam.newIdGateDescriptor = null;
        cam.newIdGateStreak = 0;
        cam.newIdGateLastAt = 0;
        if (now - cam.lastConfirmedAt >= camRecognitionHoldMs) {
          cam.people = [];
          cam.emotionSummary = "";
          cam.topEmotion = "";
          cam.lastRecognitionAt = 0;
          cam.identityLockName = "";
          cam.identityLockDistance = 0;
          cam.identityLockUntil = 0;
        }
      }
      if (isConfirmed) {
        cam.lastConfirmedAt = now;
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
            `streak=${cam.streak}/${camConfirmFrames}`,
        );
        cam.lastCandidateLogAt = now;
      }

      const needMatch = enableMatching && now - cam.lastMatchAt >= camMatchIntervalMs;
      const needEmotion = enableEmotions && now - cam.lastEmotionAt >= camEmotionIntervalMs;
      const effectiveSnapshotCooldownMs = Math.max(
        camSnapshotCooldownMs,
        camSessionSnapshotIntervalMs,
      );
      const shouldSnapshot =
        cam.confirmed > 0 &&
        (needMatch || needEmotion) &&
        now - cam.lastSnapshotAt >= effectiveSnapshotCooldownMs;

      if (shouldSnapshot) {
        cam.lastSnapshotAt = now;
        try {
          const snapTensor = faceapi.tf.tensor3d(rgb, [workerHeight, workerWidth, 3], "int32");
          let results = [];
          const runDetect = async (options) => {
            let task = faceapi.detectAllFaces(snapTensor, options);
            if (enableMatching) {
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

          results = filterAndDedupeDetections(results || [], workerWidth, workerHeight, {
            minSidePxBase: camFilterMinSidePx,
            minSideRatio: camFilterMinSideRatio,
            minAreaRatio: camFilterMinAreaRatio,
            maxAreaRatio: camFilterMaxAreaRatio,
            minScore: camFilterMinScore,
            minAspect: camFilterMinAspect,
            maxAspect: camFilterMaxAspect,
          });

          const snapshotBase64 = jpg.toString("base64");
          const people = [];
          const descriptorByName = new Map();
          let bestDistance = 0;
          let phantomRejectAction = "";
          let phantomRejectReason = "";
          let phantomRejectDistance = Number.NaN;
          let phantomRejectThreshold = Number.NaN;
          let phantomRejectTargetShortId = "";
          let phantomRejectTargetSnapshotUrl = "";
          for (const det of results) {
            let name = "unknown";
            let distance = 0;
            let justRegistered = false;
            const descriptor = descriptorToArray(det?.descriptor);
            if (enableMatching && descriptor) {
              const faceSide = getFaceSide(det);
              const identityScore = getScore(det);
              const isFrontalFace = isLikelyFrontalFace(det, {
                enabled: camRequireFrontalFace,
                minEyeDistanceRatio: camFrontalMinEyeDistanceRatio,
                maxEyeSlope: camFrontalMaxEyeSlope,
                noseCenterTolerance: camFrontalNoseCenterTolerance,
              });
              if (
                faceSide >= camMatchMinFaceSidePx &&
                identityScore >= camIdentityMinScore &&
                isFrontalFace
              ) {
                const ranked = computeMatchCandidates(knownLabeledDescriptors, descriptor);
                const bestCandidate = ranked[0];
                const second = ranked[1];
                const margin = second
                  ? second.distance - bestCandidate.distance
                  : Number.POSITIVE_INFINITY;
                const accepted =
                  Boolean(bestCandidate) &&
                  bestCandidate.distance <= camMatchThreshold &&
                  margin >= camMatchMinMargin;
                const readyForNewId = confirmNewIdCandidate(descriptor, faceSide, identityScore);

                if (sceneLooksEmpty) {
                  if (accepted && !phantomRejectAction) {
                    phantomRejectAction = "phantom_recognition_rejected";
                    phantomRejectReason =
                      "Фантомное распознавание отклонено: кадр совпадает с пустой сценой.";
                    phantomRejectDistance = Number(bestCandidate?.distance ?? Number.NaN);
                    phantomRejectThreshold = camMatchThreshold;
                    phantomRejectTargetShortId = String(bestCandidate?.label ?? "").trim();
                    phantomRejectTargetSnapshotUrl = String(
                      phantomSceneMatch?.baseline?.publicUrl ?? "",
                    ).trim();
                  } else if (readyForNewId && !phantomRejectAction) {
                    phantomRejectAction = "phantom_registration_rejected";
                    phantomRejectReason =
                      "Фантомная регистрация отклонена: кадр совпадает с пустой сценой.";
                    phantomRejectDistance = Number(bestCandidate?.distance ?? Number.NaN);
                    phantomRejectThreshold = camMatchThreshold;
                    phantomRejectTargetShortId = `baseline:${cam.cameraId}`;
                    phantomRejectTargetSnapshotUrl = String(
                      phantomSceneMatch?.baseline?.publicUrl ?? "",
                    ).trim();
                  }
                } else if (accepted) {
                  resetNewIdGate();
                  name = bestCandidate.label;
                  distance = Number(bestCandidate.distance) || 0;
                  if (!bestDistance || distance < bestDistance) bestDistance = distance;
                } else if (faceAutoCreate) {
                  const lockActive = cam.identityLockName && now < cam.identityLockUntil;
                  if (lockActive) {
                    name = cam.identityLockName;
                    distance = Number(cam.identityLockDistance) || 0;
                  } else if (readyForNewId) {
                    const identified = await identifyFaceDescriptor(
                      descriptor,
                      camMatchThreshold,
                      snapshotBase64,
                    );
                    if (identified?.shortId) {
                      resetNewIdGate();
                      name = identified.shortId;
                      justRegistered = Boolean(identified.created);
                      if (Number.isFinite(identified.distance) && identified.distance > 0) {
                        distance = Number(identified.distance) || 0;
                        if (!bestDistance || distance < bestDistance) bestDistance = distance;
                      }
                      if (justRegistered) {
                        log(`[${cam.cameraId}] new_id created shortId=${name}`);
                      }
                    }
                  }
                }
              }
            }
            if (!isUnknownIdentity(name)) {
              const lock = applyIdentityLock(name, distance);
              if (lock.overridden) {
                justRegistered = false;
              }
              name = lock.name;
              distance = Number(lock.distance) || 0;
              if (descriptor && !lock.overridden) {
                descriptorByName.set(name, descriptor);
              }
              if (distance > 0 && (!bestDistance || distance < bestDistance)) {
                bestDistance = distance;
              }
            }

            const parsedEmotion = parseEmotionFromExpressions(det?.expressions, emotionKeys);
            let emotionKey = parsedEmotion.key;
            let emotionConfidence = parsedEmotion.confidence;
            if (emotionKey && !isUnknownIdentity(name)) {
              const prev = cam.emotionEmaByName.get(name);
              const smoothed = {};
              for (const key of emotionKeys) {
                const currentVal = Number(parsedEmotion.vector[key] ?? 0);
                const prevVal = Number(prev?.[key] ?? currentVal);
                smoothed[key] = prev
                  ? camEmotionEmaAlpha * currentVal + (1 - camEmotionEmaAlpha) * prevVal
                  : currentVal;
              }

              const parsedSmoothed = parseEmotionFromExpressions(smoothed, emotionKeys);
              emotionKey = parsedSmoothed.key;
              emotionConfidence = parsedSmoothed.confidence;
              cam.emotionEmaByName.set(name, smoothed);
              cam.emotionSeenAtByName.set(name, now);
            }

            const strongEmotion = emotionKey && emotionConfidence >= camEmotionMinConfidence;
            const lowConfidenceEmotion =
              emotionKey &&
              camEmotionAllowLowConfidenceLabel &&
              emotionConfidence >= camEmotionLowConfidenceFloor;
            const emotionLabel =
              strongEmotion || lowConfidenceEmotion
                ? `${emotionKey} ${(emotionConfidence * 100).toFixed(0)}%`
                : "";

            if (!isUnknownIdentity(name)) {
              people.push({
                name,
                emotion: emotionLabel,
                emotionKey: emotionKey || "",
                emotionConfidence: Number(emotionConfidence.toFixed(4)),
                distance: Number(distance.toFixed(3)),
                justRegistered,
              });
            }
          }

          if (
            sceneLooksEmpty &&
            phantomRejectAction &&
            now - cam.lastPhantomLogAt >= camPhantomLogCooldownMs
          ) {
            cam.lastPhantomLogAt = now;
            try {
              const sourceSnapshotUrl = await savePhantomSnapshot(
                phantomSnapshotDir,
                phantomSnapshotPublicBase,
                cam.cameraId,
                jpg,
                now,
              );
              await writePhantomRejectionLog({
                cameraId: cam.cameraId,
                action: phantomRejectAction,
                reason: phantomRejectReason,
                sourceSnapshotUrl,
                targetSnapshotUrl: phantomRejectTargetSnapshotUrl,
                targetShortId: phantomRejectTargetShortId,
                distance: phantomRejectDistance,
                threshold: phantomRejectThreshold,
              });
              log(
                `[${cam.cameraId}] phantom_rejected action=${phantomRejectAction} ` +
                  `hash_distance=${Number(phantomSceneMatch?.distance ?? 0)} ` +
                  `hash_threshold=${camPhantomHashDistanceMax}`,
              );
            } catch (err) {
              if (now - cam.lastErrLogAt >= 2000) {
                log(`[${cam.cameraId}] phantom log error: ${String(err)}`);
                cam.lastErrLogAt = now;
              }
            }
          }

          for (const [savedName, seenAt] of cam.emotionSeenAtByName.entries()) {
            if (now - seenAt > emotionEmaTtlMs) {
              cam.emotionSeenAtByName.delete(savedName);
              cam.emotionEmaByName.delete(savedName);
            }
          }
          if (camFaceArchiveEnabled && people.length) {
            const seenNames = new Set();
            for (const person of people) {
              const personName = String(person?.name ?? "").trim();
              if (!personName || isUnknownIdentity(personName) || seenNames.has(personName)) continue;
              seenNames.add(personName);
              const lastArchivedAt = Number(cam.lastFaceArchiveAtByName.get(personName) ?? 0);
              if (now - lastArchivedAt < camFaceArchiveCooldownMs) continue;
              try {
                const archived = await archiveFaceSnapshot({
                  archiveDir: faceArchiveDir,
                  archivePublicBase: faceArchivePublicBase,
                  faceShortId: personName,
                  cameraId: cam.cameraId,
                  jpgBuffer: jpg,
                  now,
                  maxPerFace: camFaceArchiveMaxPerFace,
                });
                if (archived) {
                  cam.lastFaceArchiveAtByName.set(personName, now);
                }
              } catch (err) {
                if (now - cam.lastErrLogAt >= 2000) {
                  log(`[${cam.cameraId}] face archive error: ${String(err)}`);
                  cam.lastErrLogAt = now;
                }
              }
            }
            const archiveTtl = Math.max(camFaceArchiveCooldownMs * 10, 60_000);
            for (const [savedName, savedAt] of cam.lastFaceArchiveAtByName.entries()) {
              if (seenNames.has(savedName)) continue;
              if (now - Number(savedAt || 0) > archiveTtl) {
                cam.lastFaceArchiveAtByName.delete(savedName);
              }
            }
          }

          cam.people = people;
          cam.matchedNames = people.map((p) => p.name);
          cam.matchDistance = people.length ? Number(bestDistance || 0) : 0;
          const matchedNamesNow = new Set(
            people.map((p) => p.name).filter((name) => !isUnknownIdentity(name)),
          );
          for (const matchedName of matchedNamesNow) {
            cam.lastSeenMatchedAt.set(matchedName, now);
          }
          for (const [savedName, seenAt] of cam.lastSeenMatchedAt.entries()) {
            if (!matchedNamesNow.has(savedName) && now - seenAt > dbSeenTtlMs) {
              cam.lastSeenMatchedAt.delete(savedName);
              cam.lastDbSentAt.delete(`${cam.cameraId}:${savedName}`);
            }
          }
          evictPresenceSessions(matchedNamesNow);
          if (people.length) {
            cam.lastRecognitionAt = now;
          }

          if (
            saveSnapshots &&
            people.length &&
            now - cam.lastSnapshotSavedAt >= Math.max(snapshotSaveCooldownMs, camSessionSnapshotIntervalMs)
          ) {
            try {
              const snapshotFile = path.join(snapshotDir, `${cam.cameraId}.jpg`);
              await fsp.writeFile(snapshotFile, jpg);
              cam.snapshotUrl = `${snapshotPublicBase}/${cam.cameraId}.jpg?v=${now}`;
              cam.lastSnapshotSavedAt = now;
              const snapshotFaces = people
                .map((person) => `${person.name}:${person.emotion || "-"}`)
                .join(", ");
              if (snapshotFaces) {
                log(`[${cam.cameraId}] snapshot faces=${snapshotFaces}`);
              }
            } catch (err) {
              if (now - cam.lastErrLogAt >= 2000) {
                log(`[${cam.cameraId}] snapshot save error: ${String(err)}`);
                cam.lastErrLogAt = now;
              }
            }
          }

          if (enableMatching && people.length) {
            for (const person of people) {
              if (isUnknownIdentity(person.name)) continue;
              const sessionKey = person.name;
              let session = cam.presenceSessions.get(sessionKey);
              if (!session) {
                session = createPresenceSession(now);
                cam.presenceSessions.set(sessionKey, session);
              }
              session.lastSeenAt = now;

              const personDistance = Number(person.distance ?? 0);
              if (Number.isFinite(personDistance) && personDistance > 0) {
                session.bestDistance = Math.min(
                  Number(session.bestDistance ?? Number.POSITIVE_INFINITY),
                  personDistance,
                );
              }

              const shouldTakeSessionSample =
                session.sampleCount === 0 ||
                now - session.lastSampleAt >= camSessionSnapshotIntervalMs;
              if (shouldTakeSessionSample) {
                session.lastSampleAt = now;
                session.sampleCount += 1;
                addSessionEmotionSample(session, person.emotionKey, person.emotionConfidence);
              }

              const directMoodLabel = String(person.emotion || "").split(" ")[0];
              if (directMoodLabel) {
                session.lastMoodLabel = directMoodLabel;
              }

              let moodLabel = directMoodLabel;
              let resolvedEmotionLabel = String(person.emotion || "");
              let resolvedEmotionConfidence = Number(person.emotionConfidence ?? 0);
              const sessionAgeMs = now - session.startedAt;
              const canResolveFromSamples =
                session.sampleCount >= camSessionMinSamples &&
                sessionAgeMs >= camSessionResolveWaitMs &&
                (session.emotionSampleCount >= camSessionMinEmotionSamples || dbAllowMoodFallback);
              if (!moodLabel && canResolveFromSamples) {
                const resolved = resolveSessionEmotionLabel({
                  session,
                  minConfidence: camEmotionMinConfidence,
                  lowConfidenceFloor: camEmotionLowConfidenceFloor,
                  allowLowConfidenceLabel: camEmotionAllowLowConfidenceLabel,
                  allowFallbackMood: dbAllowMoodFallback,
                  fallbackMood: dbFallbackMood,
                });
                moodLabel = resolved.moodLabel;
                if (resolved.emotionLabel) {
                  resolvedEmotionLabel = resolved.emotionLabel;
                }
                if (Number.isFinite(resolved.emotionConfidence)) {
                  resolvedEmotionConfidence = Number(resolved.emotionConfidence);
                }
              }
              if (!moodLabel && person.justRegistered && dbAllowMoodFallback) {
                moodLabel = dbFallbackMood;
              }

              const readyByDirectEmotion = Boolean(directMoodLabel);
              const readyBySession =
                session.sampleCount >= camSessionMinSamples &&
                sessionAgeMs >= camSessionResolveWaitMs &&
                (session.emotionSampleCount >= camSessionMinEmotionSamples || dbAllowMoodFallback);
              const readyByNewIdentity = Boolean(person.justRegistered);
              const shouldEmitSessionRecord =
                !session.emittedAt &&
                (readyByDirectEmotion || readyBySession || readyByNewIdentity) &&
                Boolean(moodLabel);
              if (!shouldEmitSessionRecord) continue;

              const prevSeenAt = cam.lastSeenMatchedAt.get(person.name) ?? 0;
              const isReentry = prevSeenAt > 0 && now - prevSeenAt >= camDbReentryGapMs;

              const cooldownKey = `${cam.cameraId}:${person.name}`;
              const lastSent = cam.lastDbSentAt.get(cooldownKey) ?? 0;
              if (!isReentry && now - lastSent < dbCooldownMs) continue;
              cam.lastDbSentAt.set(cooldownKey, now);
              session.emittedAt = now;
              session.lastMoodLabel = moodLabel;

              if (!person.emotion && resolvedEmotionLabel) {
                person.emotion = resolvedEmotionLabel;
              }
              person.emotionConfidence = Number(
                Number.isFinite(resolvedEmotionConfidence)
                  ? resolvedEmotionConfidence
                  : Number(person.emotionConfidence ?? 0),
              );

              if (dbQueue.length >= dbQueueMaxSize) {
                dbQueue.shift();
                if (now - lastDbQueueWarnAt >= 3000) {
                  log(`[db-queue] overflow: drop oldest, size=${dbQueue.length}`);
                  lastDbQueueWarnAt = now;
                }
              }

              dbQueue.push(
                createDbQueueItem(
                  {
                    name: person.name,
                    mood: moodLabel,
                    detectedAt: new Date(now).toISOString(),
                    cameraId: cam.cameraId,
                    distance: Number.isFinite(session.bestDistance)
                      ? Number(session.bestDistance)
                      : Number(person.distance ?? 0),
                    emotionConfidence: Number(person.emotionConfidence ?? 0),
                    workerZoom: Number(cam.workerZoom.toFixed(2)),
                    frameWidth: cam.workerFrameWidth,
                    frameHeight: cam.workerFrameHeight,
                    descriptor: descriptorByName.get(person.name) || undefined,
                    snapshotUrl: cam.snapshotUrl || undefined,
                    snapshotBase64,
                  },
                  now,
                ),
              );
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
            cam.emotionSummary = cam.people
              .map((p) =>
                `${p.name}:${p.emotion || "-"}(${Number(p.emotionConfidence ?? 0).toFixed(2)})`,
              )
              .join(", ");
            cam.topEmotion =
              cam.people.find((person) => String(person?.emotion ?? "").trim())?.emotion || "";
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
          cam.identityLockName = "";
          cam.identityLockDistance = 0;
          cam.identityLockUntil = 0;
          if (now - cam.lastErrLogAt >= 2000) {
            log(`[${cam.cameraId}] snapshot error: ${String(err)}`);
            cam.lastErrLogAt = now;
          }
        }
      } else if ((!enableEmotions && !enableMatching) || cam.candidate === 0) {
        cam.matchedNames = [];
        cam.matchDistance = 0;
        cam.people = [];
        cam.emotionSummary = "";
        cam.topEmotion = "";
        cam.identityLockName = "";
        cam.identityLockDistance = 0;
        cam.identityLockUntil = 0;
        evictPresenceSessions(new Set());
      }
    } catch (err) {
      cam.candidate = 0;
      cam.confirmed = 0;
      cam.score = 0;
      cam.maxFaceSide = 0;
      cam.streak = 0;
      cam.matchedNames = [];
      cam.matchDistance = 0;
      cam.people = [];
      cam.emotionSummary = "";
      cam.topEmotion = "";
      cam.lastRecognitionAt = 0;
      cam.identityLockName = "";
      cam.identityLockDistance = 0;
      cam.identityLockUntil = 0;
      evictPresenceSessions(new Set());
      cam.frameOk = false;
      cam.workerFrameWidth = 0;
      cam.workerFrameHeight = 0;
      cam.lastFrameError = String(err);
      if (now - cam.lastErrLogAt >= 2000) {
        log(`[${cam.cameraId}] frame error: ${String(err)}`);
        cam.lastErrLogAt = now;
      }
    }

    return cam.confirmed;
  };

  while (!stopping) {
    const now = Date.now();
    let confirmedTotal = 0;
    try {
      if (now - lastZoomReloadAt >= workerZoomReloadMs) {
        workerZoomMap = await readWorkerZoomState(workerZoomStateFile);
        lastZoomReloadAt = now;
      }
      if (enableMatching && now - lastFaceRegistryReloadAt >= faceRegistryRefreshMs) {
        await reloadFaceRegistry("periodic");
      }

      const workers = [];
      let cursor = 0;
      const activeWorkers = Math.min(parallelCameraLimit, states.length);
      for (let idx = 0; idx < activeWorkers; idx += 1) {
        workers.push(
          (async () => {
            while (cursor < states.length) {
              const current = states[cursor];
              cursor += 1;
              confirmedTotal += await processCamera(current, now);
            }
          })(),
        );
      }
      await Promise.all(workers);

      const dbResult = await drainDbQueue({
        queue: dbQueue,
        now,
        maxBatchSize: dbQueueBatchSize,
        dbEndpoint,
        requestTimeoutMs: dbRequestTimeoutMs,
        maxAttempts: dbQueueMaxAttempts,
        retryBaseMs: dbQueueRetryBaseMs,
        logPrefix: "db-queue",
      });
      if ((dbResult.failed || dbResult.delayed || dbQueue.length >= dbQueueWarnAt) && now - lastDbQueueWarnAt >= 3000) {
        log(
          `[db-queue] size=${dbQueue.length} sent=${dbResult.sent} delayed=${dbResult.delayed} dropped=${dbResult.failed}`,
        );
        lastDbQueueWarnAt = now;
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
          const camConfirmFrames = Math.max(
            1,
            parseFiniteInt(
              getCameraSetting(cameraSettings, cam.cameraId, "confirmFrames", confirmFrames),
              confirmFrames,
            ),
          );
          const camPersonMinScore = parseFiniteFloat(
            getCameraSetting(cameraSettings, cam.cameraId, "personMinScore", personMinScore),
            personMinScore,
          );
          const camPersonMinSidePx = Math.max(
            10,
            parseFiniteInt(
              getCameraSetting(cameraSettings, cam.cameraId, "personMinSidePx", personMinSidePx),
              personMinSidePx,
            ),
          );
          const camPersonMinStreak = Math.max(
            1,
            parseFiniteInt(
              getCameraSetting(cameraSettings, cam.cameraId, "personMinStreak", personMinStreak),
              personMinStreak,
            ),
          );
          const hasPerson =
            cam.confirmed > 0 ||
            (cam.candidate > 0 &&
              cam.score >= camPersonMinScore &&
              cam.maxFaceSide >= camPersonMinSidePx &&
              cam.streak >= camPersonMinStreak);
          const hasFace = cam.confirmed > 0;
          const who = cam.matchedNames.length ? cam.matchedNames.join(", ") : "unknown";
          const emotion = cam.topEmotion || "none";
          const safeZoom = Number.isFinite(cam.workerZoom) ? cam.workerZoom : 1;
          const frameState = cam.frameOk
            ? `ok(${cam.lastFrameWidth}x${cam.lastFrameHeight}->${cam.workerFrameWidth}x${cam.workerFrameHeight},z=${safeZoom.toFixed(1)}x,${cam.lastFrameBytes}b)`
            : `err(${cam.lastFrameError || "unknown"})`;
          log(
            `[${cam.cameraId}] status person=${hasPerson ? 1 : 0} face=${hasFace ? 1 : 0} ` +
              `who=${who} emotion=${emotion} frame=${frameState}`,
          );
          payload.cameras[cam.cameraId] = {
            candidate: cam.candidate,
            confirmed: cam.confirmed,
            score: Number.isFinite(cam.score) ? Number(cam.score.toFixed(3)) : 0,
            maxFaceSide: Number.isFinite(cam.maxFaceSide) ? Number(cam.maxFaceSide.toFixed(1)) : 0,
            motion: Number.isFinite(cam.motion) ? Number(cam.motion.toFixed(2)) : 0,
            streak: cam.streak,
            requiredFrames: camConfirmFrames,
            matchedNames: cam.matchedNames,
            matchDistance: Number.isFinite(cam.matchDistance) ? Number(cam.matchDistance.toFixed(3)) : 0,
            personInFrame: hasPerson,
            faceInFrame: hasFace,
            workerZoom: Number(safeZoom.toFixed(2)),
            people: cam.people,
            emotionSummary: cam.emotionSummary,
            topEmotion: cam.topEmotion,
            snapshotUrl: cam.snapshotUrl,
            lastRecognitionAt: cam.lastRecognitionAt ? new Date(cam.lastRecognitionAt).toISOString() : "",
            frameOk: cam.frameOk,
            lastFrameAt: cam.lastFrameAt ? new Date(cam.lastFrameAt).toISOString() : "",
            lastFrameBytes: cam.lastFrameBytes,
            frameWidth: cam.lastFrameWidth,
            frameHeight: cam.lastFrameHeight,
            workerFrameWidth: cam.workerFrameWidth,
            workerFrameHeight: cam.workerFrameHeight,
            frameError: cam.lastFrameError,
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
    } catch (err) {
      if (now - lastLoopErrLogAt >= 1000) {
        log(`[loop] unexpected error: ${String(err)}`);
        lastLoopErrLogAt = now;
      }
      await sleep(Math.max(loopDelayMs, 200));
    }
  }

  if (dbQueue.length) {
    await drainDbQueue({
      queue: dbQueue,
      now: Date.now(),
      maxBatchSize: dbQueue.length,
      dbEndpoint,
      requestTimeoutMs: dbRequestTimeoutMs,
      maxAttempts: dbQueueMaxAttempts,
      retryBaseMs: dbQueueRetryBaseMs,
      logPrefix: "db-queue",
    });
    if (dbQueue.length) {
      log(`[db-queue] pending after stop=${dbQueue.length}`);
    }
  }

  log("stop signal received");
}

main().catch((err) => {
  process.stderr.write(`[node-detection-worker] fatal: ${String(err)}\n`);
  process.exit(1);
});


