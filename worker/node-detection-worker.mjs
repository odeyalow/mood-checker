#!/usr/bin/env node
/* Worker orchestrator with InsightFace backend for detection/embeddings and face-api fallback/emotions. */

import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import "@tensorflow/tfjs-node";
import * as faceapi from "@vladmandic/face-api";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_DESCRIPTOR_LENGTHS = new Set([128, 512]);

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

function toBase64(buffer) {
  if (!(buffer instanceof Buffer) || !buffer.length) return "";
  return buffer.toString("base64");
}

function pickPythonCandidates() {
  const candidates = [];
  const explicit = String(process.env.WORKER_PYTHON_BIN ?? "").trim();
  if (explicit) candidates.push(explicit);

  const localVenv = [
    path.join(rootDir, ".venv", "Scripts", "python.exe"),
    path.join(rootDir, ".venv", "bin", "python"),
  ];
  for (const candidate of localVenv) {
    if (fs.existsSync(candidate)) candidates.push(candidate);
  }

  candidates.push("python", "python3");
  return Array.from(new Set(candidates));
}

async function isInsightFaceServiceHealthy(healthUrl, timeoutMs) {
  if (!healthUrl) return false;
  try {
    await getJsonWithTimeout(healthUrl, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForInsightFaceService(healthUrl, timeoutMs, intervalMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isInsightFaceServiceHealthy(healthUrl, Math.min(1200, timeoutMs))) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function startInsightFaceService({
  endpointBase,
  startupTimeoutMs,
}) {
  const healthUrl = `${endpointBase.replace(/\/+$/, "")}/health`;
  if (await isInsightFaceServiceHealthy(healthUrl, 1200)) {
    return { child: null, healthUrl, started: false };
  }

  const scriptPath = path.join(rootDir, "worker", "insightface-service.py");
  const candidates = pickPythonCandidates();
  let child = null;

  for (const pythonBin of candidates) {
    try {
      const proc = spawn(pythonBin, ["-u", scriptPath], {
        cwd: rootDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.on("error", (err) => {
        log(`[insightface] process error python=${pythonBin} err=${String(err)}`);
      });
      proc.on("exit", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") return;
        log(`[insightface] process exited code=${String(code)} signal=${String(signal)}`);
      });

      proc.stdout?.on("data", (chunk) => {
        const text = String(chunk ?? "").trim();
        if (text) log(`[insightface] ${text}`);
      });
      proc.stderr?.on("data", (chunk) => {
        const text = String(chunk ?? "").trim();
        if (text) log(`[insightface] ${text}`);
      });

      const ready = await waitForInsightFaceService(healthUrl, startupTimeoutMs, 400);
      if (ready) {
        child = proc;
        log(`[insightface] service started python=${pythonBin}`);
        break;
      }

      proc.kill("SIGTERM");
      await sleep(250);
    } catch (err) {
      log(`[insightface] spawn failed python=${pythonBin} err=${String(err)}`);
    }
  }

  if (!child) {
    throw new Error("insightface_service_unavailable");
  }

  return { child, healthUrl, started: true };
}

function normalizeFaceShortId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

async function loadBlockedFaceIds(filePath) {
  const out = new Set();
  if (!filePath) return out;
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.ids)
      ? parsed.ids
      : [];
    for (const item of items) {
      const id = normalizeFaceShortId(item);
      if (id) out.add(id);
    }
  } catch {
    // ignore missing or malformed file
  }
  return out;
}

async function saveBlockedFaceIds(filePath, ids) {
  if (!filePath) return false;
  const list = Array.from(ids || [])
    .map((value) => normalizeFaceShortId(value))
    .filter(Boolean)
    .sort();
  const payload = {
    ids: list,
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, filePath);
  return true;
}

function normalizeIgnoreZone(zone) {
  if (!zone) return null;
  if (Array.isArray(zone) && zone.length >= 4) {
    const x = Number(zone[0]);
    const y = Number(zone[1]);
    let w = Number(zone[2]);
    let h = Number(zone[3]);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;

    // Support [x1,y1,x2,y2] by converting to [x,y,w,h] when right/bottom look absolute.
    if (w > 0 && h > 0 && (w > 1 || h > 1 || w > x || h > y) && x + w > 1.2 && y + h > 1.2) {
      w = w - x;
      h = h - y;
    }

    if (w <= 0 || h <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.max(0, Math.min(1, w)),
      h: Math.max(0, Math.min(1, h)),
    };
  }

  if (typeof zone === "object") {
    const x = Number(zone.x);
    const y = Number(zone.y);
    const w = Number(zone.w ?? zone.width);
    const h = Number(zone.h ?? zone.height);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
    if (w <= 0 || h <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.max(0, Math.min(1, w)),
      h: Math.max(0, Math.min(1, h)),
    };
  }

  return null;
}

function parseIgnoreZones() {
  const raw = (process.env.WORKER_IGNORE_ZONES_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [cameraId, zonesRaw] of Object.entries(parsed)) {
      if (!Array.isArray(zonesRaw)) continue;
      const zones = zonesRaw
        .map((zone) => normalizeIgnoreZone(zone))
        .filter(Boolean);
      if (zones.length) out[String(cameraId).trim()] = zones;
    }
    return out;
  } catch (err) {
    log(`ignore zones parse error: ${String(err)}`);
    return {};
  }
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value) || !SUPPORTED_DESCRIPTOR_LENGTHS.has(value.length)) return null;
  const descriptor = value.map((item) => Number(item));
  if (descriptor.some((item) => !Number.isFinite(item))) return null;
  return descriptor;
}

function euclideanDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return Number.POSITIVE_INFINITY;
  if (!left.length || left.length !== right.length) return Number.POSITIVE_INFINITY;
  if (left.length === 512) {
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let i = 0; i < left.length; i += 1) {
      const lv = Number(left[i]);
      const rv = Number(right[i]);
      if (!Number.isFinite(lv) || !Number.isFinite(rv)) return Number.POSITIVE_INFINITY;
      dot += lv * rv;
      normLeft += lv * lv;
      normRight += rv * rv;
    }
    if (normLeft <= 0 || normRight <= 0) return Number.POSITIVE_INFINITY;
    const cosine = dot / Math.sqrt(normLeft * normRight);
    return 1 - cosine;
  }
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (!Number.isFinite(diff)) return Number.POSITIVE_INFINITY;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
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
  const map = {};

  for (let i = 1; i <= 4; i += 1) {
    const cameraId = `cam-${String(i).padStart(2, "0")}`;
    const fallbackZoom = i === 1 ? 1 : Number.NaN;
    const zoom = clampWorkerZoom(process.env[`NEXT_PUBLIC_CAMERA_${i}_DIGITAL_ZOOM`], fallbackZoom);
    if (Number.isFinite(zoom)) {
      map[cameraId] = zoom;
    }
  }

  const raw = (process.env.WORKER_CAMERA_ZOOMS ?? "").trim();
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

function normalizeEmotionExpressions(expressions) {
  if (!expressions || typeof expressions !== "object" || Array.isArray(expressions)) return undefined;
  const normalized = {};
  for (const [key, value] of Object.entries(expressions)) {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) continue;
    normalized[key] = Math.max(0, numeric);
  }
  return Object.keys(normalized).length ? normalized : undefined;
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
  const adjusted = {};
  let nonNeutralSum = 0;
  for (const k of keys) {
    const v = Number(expressions[k] ?? 0);
    const safe = Number.isFinite(v) ? Math.max(0, v) : 0;
    vector[k] = safe;
    if (k !== "neutral") {
      nonNeutralSum += safe;
    }
  }

  const neutral = Number(vector.neutral ?? 0);
  const expressiveShare = neutral + nonNeutralSum > 0 ? nonNeutralSum / (neutral + nonNeutralSum) : 0;
  let topKey = "";
  let topVal = -1;
  for (const k of keys) {
    const safe = Number(vector[k] ?? 0);
    let effective = safe;
    if (k === "neutral") {
      const neutralDiscount = Math.max(0.05, 0.24 - expressiveShare * 0.52);
      effective *= neutralDiscount;
    }
    if (k === "happy") effective *= 1.34;
    if (k === "surprised") effective *= 1.26;
    if (k === "sad") effective *= 1.20;
    if (k === "angry") effective *= 1.20;
    if (k === "disgusted") effective *= 1.16;
    if (k === "fearful") effective *= 1.16;
    if (k !== "neutral" && expressiveShare >= 0.01) effective *= 1.16;
    adjusted[k] = effective;
    if (effective > topVal) {
      topVal = effective;
      topKey = k;
    }
  }

  let runnerUpKey = "";
  let runnerUpAdjusted = -1;
  for (const k of keys) {
    if (k === topKey) continue;
    const candidate = Number(adjusted[k] ?? 0);
    if (candidate > runnerUpAdjusted) {
      runnerUpAdjusted = candidate;
      runnerUpKey = k;
    }
  }

  if (topKey === "neutral" && runnerUpKey && runnerUpKey !== "neutral") {
    const expressiveRaw = Number(vector[runnerUpKey] ?? 0);
    const expressiveAdjusted = Number(adjusted[runnerUpKey] ?? expressiveRaw);
    const neutralAdjusted = Number(adjusted.neutral ?? neutral);
    const expressiveClose = expressiveAdjusted >= neutralAdjusted * Math.max(0.05, 0.2 - expressiveShare * 0.3);
    const expressiveEnough = expressiveRaw >= Math.max(0.004, neutral * 0.012);
    if (expressiveEnough && expressiveClose) {
      topKey = runnerUpKey;
      topVal = expressiveAdjusted;
      runnerUpAdjusted = neutralAdjusted;
    }
  }

  // Keep neutral from dominating long-tail signals: promote the strongest
  // expressive class when non-neutral share is non-trivial.
  if (topKey === "neutral" && runnerUpKey && runnerUpKey !== "neutral" && expressiveShare >= 0.01) {
    topKey = runnerUpKey;
    topVal = Number(adjusted[runnerUpKey] ?? vector[runnerUpKey] ?? 0);
  }

  const rawConfidence = Number(vector[topKey] ?? 0);
  const adjustedConfidence = Number(adjusted[topKey] ?? rawConfidence);
  const contrast = Math.max(0, adjustedConfidence - Math.max(0, runnerUpAdjusted));
  const confidence = topKey === "neutral"
    ? rawConfidence
    : Math.min(0.99, Math.max(rawConfidence, adjustedConfidence) + contrast * 0.35 + expressiveShare * 0.05);

  return {
    key: topKey,
    confidence: confidence > 0 ? confidence : 0,
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

function normalizeCropRect(rect, maxWidth, maxHeight) {
  if (!rect || typeof rect !== "object") return null;
  let x = Number(rect.x ?? 0);
  let y = Number(rect.y ?? 0);
  let width = Number(rect.width ?? 0);
  let height = Number(rect.height ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  if (x >= maxWidth || y >= maxHeight) return null;
  const right = Math.min(maxWidth, x + width);
  const bottom = Math.min(maxHeight, y + height);
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function expandCropRect(rect, maxWidth, maxHeight, padding = 0.18) {
  if (!rect || typeof rect !== "object") return null;
  const padX = Math.round((rect.width ?? 0) * padding);
  const padY = Math.round((rect.height ?? 0) * padding);
  return normalizeCropRect(
    {
      x: Number(rect.x ?? 0) - padX,
      y: Number(rect.y ?? 0) - padY,
      width: Number(rect.width ?? 0) + padX * 2,
      height: Number(rect.height ?? 0) + padY * 2,
    },
    maxWidth,
    maxHeight,
  );
}

async function cropJpegBuffer(buffer, rect) {
  if (!(buffer instanceof Buffer) || !buffer.length || !rect) return null;
  const image = await loadImage(buffer);
  const canvas = createCanvas(rect.width, rect.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return Buffer.from(canvas.toBuffer("image/jpeg", { quality: 0.92 }));
}

async function savePhantomSnapshot(snapshotDir, publicBase, cameraId, jpgBuffer, now, faceRect = null) {
  if (!snapshotDir || !publicBase || !(jpgBuffer instanceof Buffer) || !jpgBuffer.length) return "";
  const safeCameraId = sanitizeFileName(cameraId || "cam");
  if (!safeCameraId) return "";
  const dirAbs = path.join(snapshotDir, safeCameraId);
  await fsp.mkdir(dirAbs, { recursive: true });
  const fileName = `${now}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fileAbs = path.join(dirAbs, fileName);
  let fileBuffer = jpgBuffer;
  if (faceRect) {
    try {
      const cropped = await cropJpegBuffer(jpgBuffer, faceRect);
      if (cropped && cropped.length) {
        fileBuffer = cropped;
      }
    } catch (_) {
      // fallback to original frame
    }
  }
  await fsp.writeFile(fileAbs, fileBuffer);
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
  emotionKeys,
  minConfidence,
  lowConfidenceFloor,
  allowLowConfidenceLabel,
  allowFallbackMood,
  fallbackMood,
}) {
  const vector = {};
  for (const [key, stats] of session.emotionStats.entries()) {
    const count = Number(stats?.count ?? 0);
    const sum = Number(stats?.sum ?? 0);
    const peak = Number(stats?.max ?? 0);
    if (!count || !Number.isFinite(sum)) continue;
    const avg = sum / count;
    const safePeak = Number.isFinite(peak) ? peak : avg;
    const supportBoost = Math.min(1.08, 1 + Math.max(0, count - 1) * 0.02);
    vector[key] = (avg * 0.75 + safePeak * 0.25) * supportBoost;
  }

  const parsed = parseEmotionFromExpressions(vector, emotionKeys || Object.keys(vector));
  if (parsed.key) {
    const aggregatedConfidence = Number(parsed.confidence ?? 0);
    if (aggregatedConfidence >= minConfidence) {
      return {
        moodLabel: parsed.key,
        emotionLabel: `${parsed.key} ${(aggregatedConfidence * 100).toFixed(0)}%`,
        emotionConfidence: Number(aggregatedConfidence.toFixed(4)),
      };
    }
    if (allowLowConfidenceLabel && aggregatedConfidence >= lowConfidenceFloor) {
      return {
        moodLabel: parsed.key,
        emotionLabel: `${parsed.key} ${(aggregatedConfidence * 100).toFixed(0)}%`,
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

function createLandmarksAdapter(landmarks) {
  const safe = landmarks && typeof landmarks === "object" ? landmarks : {};
  const leftEye = Array.isArray(safe.leftEye) ? safe.leftEye : [];
  const rightEye = Array.isArray(safe.rightEye) ? safe.rightEye : [];
  const nose = Array.isArray(safe.nose) ? safe.nose : [];
  return {
    getLeftEye() {
      return leftEye;
    },
    getRightEye() {
      return rightEye;
    },
    getNose() {
      return nose;
    },
  };
}

function createDetectionFromInsightFace(face) {
  if (!face || typeof face !== "object") return null;
  const box = face.box && typeof face.box === "object" ? face.box : null;
  if (!box) return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  const score = Number(face.score);
  if (![x, y, width, height].every((item) => Number.isFinite(item))) return null;
  if (width <= 0 || height <= 0) return null;
  const det = {
    box: { x, y, width, height },
    detection: {
      box: { x, y, width, height },
      score: Number.isFinite(score) ? score : 0,
    },
    score: Number.isFinite(score) ? score : 0,
    descriptor: normalizeDescriptor(face.descriptor),
    expressions: normalizeEmotionExpressions(face.expressions),
    landmarks: createLandmarksAdapter(face.landmarks),
  };
  return det;
}

function normalizeInsightFaceResult(payload) {
  const faces = Array.isArray(payload?.faces) ? payload.faces : [];
  return faces.map((face) => createDetectionFromInsightFace(face)).filter(Boolean);
}

function isLikelyFrontalFace(
  det,
  {
    enabled = true,
    minEyeDistanceRatio = 0.22,
    maxEyeSlope = 0.14,
    noseCenterTolerance = 0.18,
    minEyeMarginRatio = 0.12,
    minEyeLineYRatio = 0.12,
    maxEyeLineYRatio = 0.55,
    minNoseDropRatio = 0.04,
    maxNoseYRatio = 0.72,
  } = {},
) {
  if (!enabled) return true;
  const box = getBox(det);
  if (!box) return false;
  const landmarks = det?.landmarks;
  if (!landmarks?.getLeftEye || !landmarks?.getRightEye || !landmarks?.getNose) {
    // No landmark API — can't check, allow through
    return true;
  }

  const leftEye = getLandmarkCenter(landmarks.getLeftEye());
  const rightEye = getLandmarkCenter(landmarks.getRightEye());
  const nose = getLandmarkCenter(landmarks.getNose());
  // Landmark data missing (e.g. InsightFace with empty arrays) — allow through
  if (!leftEye || !rightEye || !nose) return true;

  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const eyeDist = Math.hypot(eyeDx, eyeDy);
  const eyeDistRatio = eyeDist / Math.max(1, box.width);
  if (eyeDistRatio < minEyeDistanceRatio) return false;

  const eyeSlope = Math.abs(eyeDy) / Math.max(1e-6, eyeDist);
  if (eyeSlope > maxEyeSlope) return false;

  const leftEyeXRatio = (leftEye.x - box.x) / Math.max(1, box.width);
  const rightEyeXRatio = (rightEye.x - box.x) / Math.max(1, box.width);
  if (leftEyeXRatio < minEyeMarginRatio || rightEyeXRatio > 1 - minEyeMarginRatio) return false;

  const eyeLineY = (leftEye.y + rightEye.y) / 2;
  const eyeLineYRatio = (eyeLineY - box.y) / Math.max(1, box.height);
  if (eyeLineYRatio < minEyeLineYRatio || eyeLineYRatio > maxEyeLineYRatio) return false;

  const eyeLeftX = Math.min(leftEye.x, rightEye.x);
  const eyeRightX = Math.max(leftEye.x, rightEye.x);
  const noseBetweenEyes = (nose.x - eyeLeftX) / Math.max(1e-6, eyeRightX - eyeLeftX);
  if (noseBetweenEyes < 0.2 || noseBetweenEyes > 0.8) return false;

  const centerX = box.x + box.width / 2;
  const noseCenterOffset = Math.abs((nose.x - centerX) / Math.max(1, box.width));
  if (noseCenterOffset > noseCenterTolerance) return false;

  const noseYRatio = (nose.y - box.y) / Math.max(1, box.height);
  const noseDropRatio = (nose.y - eyeLineY) / Math.max(1, box.height);
  if (noseDropRatio < minNoseDropRatio) return false;
  if (noseYRatio > maxNoseYRatio) return false;

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

function boxCenterDistanceRatio(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const dx = acx - bcx;
  const dy = acy - bcy;
  const diagonal = Math.hypot(
    Math.max(1, (a.width + b.width) / 2),
    Math.max(1, (a.height + b.height) / 2),
  );
  return Math.hypot(dx, dy) / diagonal;
}

function boxSizeSimilarity(a, b) {
  if (!a || !b) return 0;
  const widthRatio = Math.min(a.width, b.width) / Math.max(1, Math.max(a.width, b.width));
  const heightRatio = Math.min(a.height, b.height) / Math.max(1, Math.max(a.height, b.height));
  return Math.max(0, Math.min(1, (widthRatio + heightRatio) / 2));
}

function emotionDetectionMatchScore(faceBox, emotionBox) {
  const overlap = iou(faceBox, emotionBox);
  const centerRatio = boxCenterDistanceRatio(faceBox, emotionBox);
  const sizeSimilarity = boxSizeSimilarity(faceBox, emotionBox);
  if (!Number.isFinite(centerRatio)) return -1;
  return overlap * 1.8 + sizeSimilarity * 0.7 - centerRatio;
}

function rectOverlapRatio(subject, zone) {
  const sx2 = subject.x + subject.width;
  const sy2 = subject.y + subject.height;
  const zx2 = zone.x + zone.width;
  const zy2 = zone.y + zone.height;
  const ix1 = Math.max(subject.x, zone.x);
  const iy1 = Math.max(subject.y, zone.y);
  const ix2 = Math.min(sx2, zx2);
  const iy2 = Math.min(sy2, zy2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const area = Math.max(1, subject.width * subject.height);
  return inter / area;
}

function isDetectionIgnoredByZones(det, zones, frameWidth, frameHeight, overlapThreshold = 0.35) {
  if (!Array.isArray(zones) || !zones.length) return false;
  const box = getBox(det);
  if (!box) return false;
  for (const zone of zones) {
    const zx = Math.floor(Number(zone.x ?? 0) * frameWidth);
    const zy = Math.floor(Number(zone.y ?? 0) * frameHeight);
    const zw = Math.floor(Number(zone.w ?? 0) * frameWidth);
    const zh = Math.floor(Number(zone.h ?? 0) * frameHeight);
    if (!zw || !zh) continue;
    const ratio = rectOverlapRatio(
      {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      {
        x: zx,
        y: zy,
        width: zw,
        height: zh,
      },
    );
    if (ratio >= overlapThreshold) return true;
  }
  return false;
}

function estimateFaceSharpness(rgb, frameWidth, frameHeight, det) {
  const box = getBox(det);
  if (!box || !(rgb instanceof Uint8Array)) return 0;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(frameWidth - 1, Math.ceil(box.x + box.width));
  const y1 = Math.min(frameHeight - 1, Math.ceil(box.y + box.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w < 8 || h < 8) return 0;

  let sum = 0;
  let count = 0;
  for (let y = y0 + 1; y < y1; y += 1) {
    for (let x = x0 + 1; x < x1; x += 1) {
      const idx = (y * frameWidth + x) * 3;
      const left = idx - 3;
      const up = idx - frameWidth * 3;
      const lum = (77 * rgb[idx] + 150 * rgb[idx + 1] + 29 * rgb[idx + 2]) >> 8;
      const lumLeft = (77 * rgb[left] + 150 * rgb[left + 1] + 29 * rgb[left + 2]) >> 8;
      const lumUp = (77 * rgb[up] + 150 * rgb[up + 1] + 29 * rgb[up + 2]) >> 8;
      sum += Math.abs(lum - lumLeft) + Math.abs(lum - lumUp);
      count += 1;
    }
  }
  if (!count) return 0;
  return sum / count;
}

function buildDescriptorBankFromBlockedIds(labeledDescriptors, blockedIds) {
  const bank = [];
  if (!Array.isArray(labeledDescriptors) || !labeledDescriptors.length) return bank;
  if (!(blockedIds instanceof Set) || !blockedIds.size) return bank;
  for (const item of labeledDescriptors) {
    const label = normalizeFaceShortId(item?.label);
    if (!label || !blockedIds.has(label)) continue;
    const descriptors = Array.isArray(item?.descriptors) ? item.descriptors : [];
    for (const descriptor of descriptors) {
      const safe = normalizeDescriptor(descriptor);
      if (!safe) continue;
      bank.push({ label, descriptor: safe });
    }
  }
  return bank;
}

function findClosestDescriptorInBank(bank, descriptor) {
  const safe = normalizeDescriptor(descriptor);
  if (!safe || !Array.isArray(bank) || !bank.length) return null;
  let best = null;
  for (const entry of bank) {
    const known = normalizeDescriptor(entry?.descriptor);
    if (!known) continue;
    const distance = Number(euclideanDistance(safe, known));
    if (!Number.isFinite(distance)) continue;
    if (!best || distance < best.distance) {
      best = { label: String(entry?.label || ""), distance };
    }
  }
  return best;
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
      const dist = Number(euclideanDistance(descriptor, known));
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

function clampFrameOffsetY(value, fallback = 0) {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(0.35, Math.max(-0.35, Number(parsed.toFixed(3))));
}

function parseWorkerFrameOffsetDefaults() {
  const map = {};
  for (let i = 1; i <= 4; i += 1) {
    const cameraId = `cam-${String(i).padStart(2, "0")}`;
    const fallbackOffset = i === 1 ? 0 : Number.NaN;
    const offset = clampFrameOffsetY(
      process.env[`NEXT_PUBLIC_CAMERA_${i}_FRAME_OFFSET_Y`],
      fallbackOffset,
    );
    if (Number.isFinite(offset)) {
      map[cameraId] = offset;
    }
  }
  return map;
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

function validateFrameBuffer(buffer) {
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error("empty_frame");
  }
  if (buffer.length < 4) {
    throw new Error("invalid_frame_too_small");
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  if (!isJpeg && !isPng) {
    throw new Error("invalid_frame_format");
  }
}

async function decodeFrameImage(buffer, timeoutMs) {
  validateFrameBuffer(buffer);

  let timeout = null;
  try {
    return await Promise.race([
      loadImage(buffer),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("image_decode_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`db_http_${res.status}${body ? ` body=${body.slice(0, 180)}` : ""}`);
    }
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return body;
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

function isRetriableFrameError(err) {
  const message = String(err ?? "");
  return (
    isAbortError(err) ||
    /frame_http_5\d\d/.test(message) ||
    /frame_http_429/.test(message)
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

function createJsonlQueueWriter(filePath) {
  let chain = Promise.resolve();
  let initialized = false;

  return async function enqueue(payload) {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const line = `${JSON.stringify({
      payload: safePayload,
      attempts: 0,
      nextAttemptAt: Date.now(),
      enqueuedAt: new Date().toISOString(),
    })}\n`;

    chain = chain.then(async () => {
      if (!initialized) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        initialized = true;
      }
      await fsp.appendFile(filePath, line, "utf-8");
    });

    return chain;
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
        const result = await postJsonWithTimeout(dbEndpoint, item.payload, requestTimeoutMs);
        if (result && typeof result === "object" && !Array.isArray(result)) {
          const skipped = String(result.skipped || "").trim();
          if (skipped) {
            log(
              `[${logPrefix}] skipped reason=${skipped} name=${String(item.payload?.name || "")} ` +
                `camera=${String(item.payload?.cameraId || "none")} mood=${String(item.payload?.mood || "")}`,
            );
          } else if (result.updated) {
            log(
              `[${logPrefix}] updated existing recognition name=${String(item.payload?.name || "")} ` +
                `camera=${String(item.payload?.cameraId || "none")} mood=${String(item.payload?.mood || "")}`,
            );
          }
        }
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

function createEmptyCameraStatus({ workerZoom = 1, workerOffsetY = 0, frameError = "" } = {}) {
  return {
    candidate: 0,
    confirmed: 0,
    score: 0,
    maxFaceSide: 0,
    motion: 0,
    streak: 0,
    requiredFrames: 1,
    matchedNames: [],
    matchDistance: 0,
    personInFrame: false,
    faceInFrame: false,
    workerZoom: Number.isFinite(workerZoom) ? Number(workerZoom.toFixed(2)) : 1,
    workerOffsetY: Number.isFinite(workerOffsetY) ? Number(workerOffsetY.toFixed(3)) : 0,
    people: [],
    emotionSummary: "",
    topEmotion: "",
    lastRecognitionEmotion: "",
    lastRecognitionMood: "",
    previewUrl: "",
    snapshotUrl: "",
    lastRecognitionAt: "",
    frameOk: false,
    lastFrameAt: "",
    lastFrameBytes: 0,
    frameWidth: 0,
    frameHeight: 0,
    workerFrameWidth: 0,
    workerFrameHeight: 0,
    lastDetectionBoxes: [],
    snapshotSavedCount: 0,
    frameError,
  };
}

async function writeBootStatusFile(filePath, cameras, frameError = "worker_booting") {
  const payload = {
    ts: new Date().toISOString(),
    cameras: Object.fromEntries(
      (Array.isArray(cameras) ? cameras : []).map((camera) => [
        String(camera?.cameraId ?? ""),
        createEmptyCameraStatus({ workerZoom: 1, workerOffsetY: 0, frameError }),
      ]),
    ),
  };
  await writeStatusFile(filePath, payload);
}

function createState(cameraId, src) {
  return {
    cameraId,
    src,
    processing: false,
    processingStartedAt: 0,
    processingTimedOutAt: 0,
    workerZoom: 1,
    workerOffsetY: 0,
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
    lastRecognitionEmotion: "",
    lastRecognitionMood: "",
    previewUrl: "",
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
    lastPreviewSavedAt: 0,
    snapshotSavedCount: 0,
    lastCandidateAt: 0,
    lastEmotionAt: 0,
    lastRawEmotionKey: "",
    lastRawEmotionConfidence: 0,
    lastRawEmotionAt: 0,
    lastBestBox: null,
    lastDetectionBoxes: [],
    prevLuma: null,
    emotionEmaByName: new Map(),
    emotionSeenAtByName: new Map(),
    lastCandidateLogAt: 0,
    lastConfirmLogAt: 0,
    lastMatchLogAt: 0,
    lastEmotionLogAt: 0,
    lastErrLogAt: 0,
    lastBlockedMatchLogAt: 0,
    lastAmbiguousLogAt: 0,
    lastIdentifyAt: 0,
    lastAutoCreatedAt: 0,
    newIdGateDescriptor: null,
    newIdGateStreak: 0,
    newIdGateLastAt: 0,
    lastDbSentAt: new Map(),
    lastSeenMatchedAt: new Map(),
    lastFaceArchiveAtByName: new Map(),
    lastFaceArchiveUrlByName: new Map(),
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

function evictPresenceSessions(cam, now, absenceMs, activeNames = null) {
  if (!cam?.presenceSessions || typeof cam.presenceSessions.entries !== "function") return;
  for (const [savedName, session] of cam.presenceSessions.entries()) {
    if (activeNames && activeNames.has(savedName)) continue;
    if (now - Number(session?.lastSeenAt ?? 0) <= absenceMs) continue;
    cam.presenceSessions.delete(savedName);
  }
}

async function writeFileAtomic(filePath, buffer) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, filePath);
}

function buildDefaultFrameApiBase() {
  const go2rtcBaseUrl = (process.env.GO2RTC_BASE_URL || "http://127.0.0.1:1984").trim() || "http://127.0.0.1:1984";
  const width = Math.max(160, envInt("GO2RTC_FRAME_WIDTH", 960));
  const height = Math.max(120, envInt("GO2RTC_FRAME_HEIGHT", 540));
  const quality = Math.min(100, Math.max(1, envInt("GO2RTC_FRAME_QUALITY", 82)));
  const url = new URL(go2rtcBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/frame.jpeg`;
  url.searchParams.set("width", String(width));
  url.searchParams.set("height", String(height));
  url.searchParams.set("quality", String(quality));
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
  log(`[boot] cameras=${cameras.length} status_file=${statusFile}`);
  try {
    await writeBootStatusFile(statusFile, cameras, "worker_booting");
  } catch (err) {
    log(`[boot] initial status file write failed err=${String(err)}`);
  }
  const workerZoomStateFile = process.env.WORKER_ZOOM_STATE_FILE || "/tmp/mood-checker-worker-zoom.json";
  const workerZoomStateDir = path.dirname(workerZoomStateFile);
  await fsp.mkdir(workerZoomStateDir, { recursive: true }).catch(() => {});

  const frameApiBaseRaw = (process.env.WORKER_FRAME_API_BASE || "").trim();
  const frameApiBase = (frameApiBaseRaw || buildDefaultFrameApiBase()).replace(/\/+$/, "");
  const frameTimeoutMs = Math.max(500, envInt("WORKER_FRAME_TIMEOUT_MS", 3000));
  const frameAbortRetryEnabled = envBool("WORKER_FRAME_ABORT_RETRY_ENABLED", true);
  const frameAbortRetryTimeoutMs = Math.max(500, envInt("WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS", 5200));
  const frameAbortRetryWidth = Math.max(320, envInt("WORKER_FRAME_ABORT_RETRY_WIDTH", 1280));
  const frameAbortRetryHeight = Math.max(180, envInt("WORKER_FRAME_ABORT_RETRY_HEIGHT", 720));
  const frameAbortRetryQuality = Math.min(100, Math.max(1, envInt("WORKER_FRAME_ABORT_RETRY_QUALITY", 82)));
  const frameApiTimeoutMs = Math.max(300, frameTimeoutMs - 300);
  const frameAbortRetryApiTimeoutMs = Math.max(500, frameAbortRetryTimeoutMs - 300);
  const imageDecodeTimeoutMs = Math.max(300, envInt("WORKER_IMAGE_DECODE_TIMEOUT_MS", 1500));
  const loopDelayMs = Math.max(15, envInt("WORKER_LOOP_DELAY_MS", 50));
  const heartbeatSeconds = Math.max(1, envFloat("WORKER_HEARTBEAT_SECONDS", 5));
  const statusLogSeconds = Math.max(0.4, envFloat("WORKER_STATUS_LOG_SECONDS", 1.5));
  const detectionLogCooldownMs = Math.max(200, envInt("WORKER_DETECTION_LOG_COOLDOWN_MS", 500));
  const candidateLogCooldownMs = Math.max(200, envInt("WORKER_CANDIDATE_LOG_COOLDOWN_MS", 700));
  const confirmFrames = Math.max(1, envInt("WORKER_CONFIRM_FRAMES", 1));
  const motionThreshold = envFloat("WORKER_MOTION_THRESHOLD", 1.5);
  const minConfirmScore = envFloat("WORKER_MIN_CONFIRM_SCORE", 0.12);
  const personMinScore = envFloat(
    "WORKER_PERSON_MIN_SCORE",
    Math.max(minConfirmScore, 0.16),
  );
  const personMinSidePx = Math.max(10, envInt("WORKER_PERSON_MIN_SIDE_PX", 20));
  const personMinStreak = Math.max(1, envInt("WORKER_PERSON_MIN_STREAK", 1));
  const tinyInputSize = envInt("WORKER_TINY_INPUT_SIZE", 512);
  const tinyScoreThreshold = envFloat("WORKER_TINY_SCORE_THRESHOLD", 0.18);
  const emotionTinyInputSize = Math.max(
    128,
    envInt("WORKER_EMOTION_TINY_INPUT_SIZE", Math.min(320, Math.max(160, tinyInputSize))),
  );
  const emotionTinyScoreThreshold = Math.max(
    0.01,
    Math.min(0.5, envFloat("WORKER_EMOTION_TINY_SCORE_THRESHOLD", Math.min(0.12, tinyScoreThreshold))),
  );
  const ssdMinConfidence = envFloat("WORKER_SSD_MIN_CONFIDENCE", 0.35);
  const useSsdFallback = envBool("WORKER_USE_SSD_FALLBACK", false);
  const fastPassMode = envBool("WORKER_FAST_PASS_MODE", true);
  const filterMinScore = envFloat("WORKER_FILTER_MIN_SCORE", 0.09);
  const filterMinSidePx = envInt("WORKER_FILTER_MIN_SIDE_PX", 12);
  const filterMinSideRatio = envFloat("WORKER_FILTER_MIN_SIDE_RATIO", 0.015);
  const filterMinAreaRatio = envFloat("WORKER_FILTER_MIN_AREA_RATIO", 0.0005);
  const filterMaxAreaRatio = envFloat("WORKER_FILTER_MAX_AREA_RATIO", 0.72);
  const filterMinAspect = envFloat("WORKER_FILTER_MIN_ASPECT", 0.52);
  const filterMaxAspect = envFloat("WORKER_FILTER_MAX_ASPECT", 1.9);
  const enableMatching = envBool("WORKER_ENABLE_MATCHING", true);
  const matchThreshold = envFloat("WORKER_MATCH_THRESHOLD", 0.56);
  const matchMinMargin = Math.max(0, envFloat("WORKER_MATCH_MIN_MARGIN", 0.04));
  const ambiguousMarginFloor = Math.max(
    0,
    Math.min(0.3, envFloat("WORKER_AMBIGUOUS_MARGIN_FLOOR", 0.08)),
  );
  const matchMinFaceSidePx = Math.max(0, envInt("WORKER_MATCH_MIN_FACE_SIDE_PX", 16));
  const identityMinScore = Math.max(
    0,
    Math.min(1, envFloat("WORKER_IDENTITY_MIN_SCORE", 0.12)),
  );
  const identityLockMs = Math.max(0, envInt("WORKER_IDENTITY_LOCK_MS", 900));
  const identityLockSwitchMargin = Math.max(
    0,
    envFloat("WORKER_IDENTITY_LOCK_SWITCH_MARGIN", 0.02),
  );
  const identifyMinIntervalMs = Math.max(350, envInt("WORKER_IDENTIFY_MIN_INTERVAL_MS", 900));
  const autoCreateCooldownMs = Math.max(0, envInt("WORKER_AUTO_CREATE_COOLDOWN_MS", 2200));
  const requireFrontalFace = envBool("WORKER_REQUIRE_FRONTAL_FACE", true);
  const frontalMinEyeDistanceRatio = Math.max(
    0.05,
    envFloat("WORKER_FRONTAL_MIN_EYE_DISTANCE_RATIO", 0.22),
  );
  const frontalMaxEyeSlope = Math.max(0.02, envFloat("WORKER_FRONTAL_MAX_EYE_SLOPE", 0.14));
  const frontalNoseCenterTolerance = Math.max(
    0.05,
    envFloat("WORKER_FRONTAL_NOSE_CENTER_TOLERANCE", 0.18),
  );
  const matchIntervalMs = Math.max(120, envInt("WORKER_MATCH_INTERVAL_MS", 140));
  const matchLogCooldownMs = Math.max(300, envInt("WORKER_MATCH_LOG_COOLDOWN_MS", 1000));
  const enableEmotions = envBool("WORKER_ENABLE_EMOTIONS", true);
  const emotionIntervalMs = Math.max(150, envInt("WORKER_EMOTION_INTERVAL_MS", 300));
  const snapshotCooldownMs = Math.max(150, envInt("WORKER_SNAPSHOT_COOLDOWN_MS", 300));
  const recognitionHoldMs = Math.max(0, envInt("WORKER_RECOGNITION_HOLD_MS", 1800));
  const sessionSnapshotIntervalMs = Math.max(
    250,
    envInt("WORKER_SESSION_SNAPSHOT_INTERVAL_MS", 300),
  );
  const sessionAbsenceMs = Math.max(
    700,
    envInt("WORKER_SESSION_ABSENCE_MS", Math.max(2200, recognitionHoldMs + 800)),
  );
  const sessionResolveWaitMs = Math.max(
    0,
    envInt("WORKER_SESSION_RESOLVE_WAIT_MS", 300),
  );
  const sessionMinSamples = Math.max(1, envInt("WORKER_SESSION_MIN_SAMPLES", 1));
  const sessionMinEmotionSamples = Math.max(
    1,
    envInt("WORKER_SESSION_MIN_EMOTION_SAMPLES", 1),
  );
  const workerZoomReloadMs = Math.max(250, envInt("WORKER_ZOOM_RELOAD_MS", 700));
  const workerZoomDefaults = parseWorkerZoomDefaults();
  const workerFrameOffsetDefaults = parseWorkerFrameOffsetDefaults();
  const cameraSettings = parseCameraSettings();
  const ignoreZonesByCamera = parseIgnoreZones();
  const ignoreZoneOverlapThreshold = Math.max(
    0.05,
    Math.min(1, envFloat("WORKER_IGNORE_ZONE_OVERLAP_THRESHOLD", 0.35)),
  );
  const parallelCameraLimit = Math.max(
    1,
    envInt("WORKER_PARALLEL_CAMERAS", Math.max(1, cameras.length)),
  );
  const emotionMinConfidence = Math.max(
    0,
    Math.min(1, envFloat("WORKER_EMOTION_MIN_CONFIDENCE", 0.02)),
  );
  const emotionLowConfidenceFloor = Math.max(
    0,
    Math.min(1, envFloat("WORKER_EMOTION_LOW_CONFIDENCE_FLOOR", 0.005)),
  );
  const emotionAllowLowConfidenceLabel = envBool(
    "WORKER_EMOTION_ALLOW_LOW_CONFIDENCE_LABEL",
    true,
  );
  const emotionEmaAlpha = Math.max(0, Math.min(1, envFloat("WORKER_EMOTION_EMA_ALPHA", 0.9)));
  const emotionEmaTtlMs = Math.max(2000, envInt("WORKER_EMOTION_EMA_TTL_MS", 12000));
  const emotionCarryoverMs = Math.max(1000, envInt("WORKER_EMOTION_CARRYOVER_MS", 10000));
  const dbEndpoint = (process.env.WORKER_DB_ENDPOINT || "http://127.0.0.1:3000/api/recognitions").trim();
  const dbCooldownMs = Math.max(800, envInt("WORKER_DB_COOLDOWN_MS", 2000));
  const dbReentryGapMs = Math.max(250, envInt("WORKER_DB_REENTRY_GAP_MS", 800));
  const dbSeenTtlMs = Math.max(dbCooldownMs * 6, dbReentryGapMs * 6);
  const dbAllowMoodFallback = envBool("WORKER_DB_ALLOW_MOOD_FALLBACK", true);
  const dbFallbackMoodRaw = (process.env.WORKER_DB_FALLBACK_MOOD || "neutral").trim().toLowerCase();
  const dbFallbackMood = dbFallbackMoodRaw || "neutral";
  const dbRequestTimeoutMs = Math.max(500, envInt("WORKER_DB_TIMEOUT_MS", 1500));
  const dbWriterMode = String(process.env.WORKER_DB_WRITER_MODE || "inline").trim().toLowerCase();
  const dbQueueFile = String(
    process.env.WORKER_DB_QUEUE_FILE || path.join(rootDir, "worker", "recognition-queue.jsonl"),
  ).trim();
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
  const workerPreviewEnabled = envBool("WORKER_PREVIEW_ENABLED", true);
  const workerPreviewDir =
    process.env.WORKER_PREVIEW_DIR || path.join(rootDir, "public", "_worker-live");
  const workerPreviewPublicBase = (
    process.env.WORKER_PREVIEW_PUBLIC_BASE || "/_worker-live"
  ).replace(/\/+$/, "");
  const workerPreviewIntervalMs = Math.max(0, envInt("WORKER_PREVIEW_INTERVAL_MS", 0));
  const workerPreviewQuality = Math.min(
    0.98,
    Math.max(0.4, envFloat("WORKER_PREVIEW_QUALITY", 0.82)),
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
  const blockedFaceIdsFile =
    process.env.WORKER_BLOCKED_FACE_IDS_FILE || path.join(rootDir, "worker", "blocked-face-ids.json");
  const blockedFaceIdsReloadMs = Math.max(
    1000,
    envInt("WORKER_BLOCKED_FACE_IDS_RELOAD_MS", 5000),
  );
  const newIdConfirmFrames = Math.max(1, envInt("WORKER_NEW_ID_CONFIRM_FRAMES", 1));
  const newIdMinScore = Math.max(0, Math.min(1, envFloat("WORKER_NEW_ID_MIN_SCORE", 0.14)));
  const newIdMinFaceSidePx = Math.max(8, envInt("WORKER_NEW_ID_MIN_FACE_SIDE_PX", 20));
  const newIdEmptyMinScore = Math.max(
    0,
    Math.min(1, envFloat("WORKER_NEW_ID_EMPTY_MIN_SCORE", Math.max(newIdMinScore, 0.16))),
  );
  const newIdEmptyMinFaceSidePx = Math.max(
    8,
    envInt("WORKER_NEW_ID_EMPTY_MIN_FACE_SIDE_PX", Math.max(newIdMinFaceSidePx, 20)),
  );
  const newIdStabilityMaxDistance = Math.max(
    0.01,
    Math.min(2, envFloat("WORKER_NEW_ID_STABILITY_MAX_DISTANCE", 0.48)),
  );
  const newIdMinSharpness = Math.max(0, envFloat("WORKER_NEW_ID_MIN_SHARPNESS", 9));
  const newIdEmptyMinSharpness = Math.max(
    0,
    envFloat("WORKER_NEW_ID_EMPTY_MIN_SHARPNESS", Math.max(newIdMinSharpness, 11)),
  );
  const newIdMaxGapMs = Math.max(120, envInt("WORKER_NEW_ID_MAX_GAP_MS", 1500));
  const phantomBankThreshold = Math.max(
    0.01,
    Math.min(2, envFloat("WORKER_PHANTOM_BANK_THRESHOLD", 0.5)),
  );
  const autoBlockEnabled = envBool("WORKER_AUTO_BLOCK_ENABLED", true);
  const autoBlockWindowMs = Math.max(
    60_000,
    envInt("WORKER_AUTO_BLOCK_WINDOW_MS", 10 * 60 * 1000),
  );
  const autoBlockMinSamples = Math.max(30, envInt("WORKER_AUTO_BLOCK_MIN_SAMPLES", 80));
  const autoBlockMinRatio = Math.max(
    0.55,
    Math.min(1, envFloat("WORKER_AUTO_BLOCK_MIN_RATIO", 0.88)),
  );
  const autoBlockMinFaceScore = Math.max(
    0,
    Math.min(1, envFloat("WORKER_AUTO_BLOCK_MIN_FACE_SCORE", 0.2)),
  );
  const autoBlockMinFaceSidePx = Math.max(8, envInt("WORKER_AUTO_BLOCK_MIN_FACE_SIDE_PX", 26));
  const autoBlockMaxMotion = Math.max(0, envFloat("WORKER_AUTO_BLOCK_MAX_MOTION", 2.2));
  const autoBlockMinEmotionConfidence = Math.max(
    0,
    Math.min(1, envFloat("WORKER_AUTO_BLOCK_MIN_EMOTION_CONFIDENCE", 0.1)),
  );
  const autoBlockCooldownMs = Math.max(
    autoBlockWindowMs,
    envInt("WORKER_AUTO_BLOCK_COOLDOWN_MS", 30 * 60 * 1000),
  );
  const faceArchiveEnabled = envBool("WORKER_FACE_ARCHIVE_ENABLED", true);
  const faceArchiveCooldownMs = Math.max(500, envInt("WORKER_FACE_ARCHIVE_COOLDOWN_MS", 2500));
  const faceArchiveMaxPerFace = Math.max(5, envInt("WORKER_FACE_ARCHIVE_MAX_PER_FACE", 50));
  const faceArchiveDir = process.env.WORKER_FACE_ARCHIVE_DIR || path.join(rootDir, "public", "_faces");
  const faceArchivePublicBase = (process.env.WORKER_FACE_ARCHIVE_PUBLIC_BASE || "/_faces").replace(
    /\/+$/,
    "",
  );
  const recordMinFaceScore = Math.max(
    0,
    Math.min(1, envFloat("WORKER_RECORD_MIN_FACE_SCORE", 0.18)),
  );
  const recordMinFaceSidePx = Math.max(8, envInt("WORKER_RECORD_MIN_FACE_SIDE_PX", 24));
  const recordMinSharpness = Math.max(0, envFloat("WORKER_RECORD_MIN_SHARPNESS", 9));
  const recordMaxDistance = Math.max(
    0.01,
    Math.min(2, envFloat("WORKER_RECORD_MAX_DISTANCE", matchThreshold + 0.03)),
  );
  const phantomLogEndpoint =
    (process.env.WORKER_PHANTOM_LOG_ENDPOINT || "http://127.0.0.1:3000/api/faces/dedup-logs").trim();
  const phantomLogTimeoutMs = Math.max(400, envInt("WORKER_PHANTOM_LOG_TIMEOUT_MS", 1200));
  const phantomSnapshotDir =
    process.env.WORKER_PHANTOM_SNAPSHOT_DIR || path.join(rootDir, "public", "_phantom-rejects");
  const phantomSnapshotPublicBase = (
    process.env.WORKER_PHANTOM_SNAPSHOT_PUBLIC_BASE || "/_phantom-rejects"
  ).replace(/\/+$/, "");
  const requestedInferenceBackend = (
    process.env.WORKER_INFERENCE_BACKEND || "auto"
  ).trim().toLowerCase();
  const allowFaceApiFallback = envBool("WORKER_INFERENCE_FALLBACK_FACEAPI", true);
  const insightFacePort = Math.max(1, envInt("WORKER_INSIGHTFACE_PORT", 8765));
  const insightFaceEndpointBase = (
    process.env.WORKER_INSIGHTFACE_ENDPOINT || `http://127.0.0.1:${insightFacePort}`
  )
    .trim()
    .replace(/\/+$/, "");
  const insightFaceAnalyzeEndpoint = `${insightFaceEndpointBase}/analyze`;
  const insightFaceTimeoutMs = Math.max(500, envInt("WORKER_INSIGHTFACE_TIMEOUT_MS", 2500));
  const insightFaceStartupTimeoutMs = Math.max(
    2000,
    envInt("WORKER_INSIGHTFACE_STARTUP_TIMEOUT_MS", 30000),
  );
  const cameraProcessTimeoutMs = Math.max(
    1000,
    envInt(
      "WORKER_CAMERA_PROCESS_TIMEOUT_MS",
      Math.max(frameAbortRetryTimeoutMs + imageDecodeTimeoutMs + insightFaceTimeoutMs + 1000, 7000),
    ),
  );
  let insightFaceServiceChild = null;
  let inferenceBackend = requestedInferenceBackend === "faceapi" ? "faceapi" : "insightface";

  const restartInsightFaceService = async (reason) => {
    if (inferenceBackend !== "insightface") return false;
    if (restartInsightFaceService.inFlight) return false;
    restartInsightFaceService.inFlight = true;
    try {
      log(`[insightface] restart requested reason=${reason}`);
      if (insightFaceServiceChild && !insightFaceServiceChild.killed) {
        try {
          insightFaceServiceChild.kill("SIGTERM");
        } catch {
          // ignore shutdown errors while recovering the child process
        }
        await sleep(250);
      }

      const started = await startInsightFaceService({
        endpointBase: insightFaceEndpointBase,
        startupTimeoutMs: insightFaceStartupTimeoutMs,
      });
      insightFaceServiceChild = started.child;
      return true;
    } catch (err) {
      log(`[insightface] restart failed reason=${reason} err=${String(err)}`);
      return false;
    } finally {
      restartInsightFaceService.inFlight = false;
    }
  };
  restartInsightFaceService.inFlight = false;

  if (inferenceBackend === "insightface") {
    log(`[boot] starting insightface endpoint=${insightFaceEndpointBase}`);
    try {
      const started = await startInsightFaceService({
        endpointBase: insightFaceEndpointBase,
        startupTimeoutMs: insightFaceStartupTimeoutMs,
      });
      insightFaceServiceChild = started.child;
    } catch (err) {
      if (!allowFaceApiFallback && requestedInferenceBackend !== "auto") {
        throw err;
      }
      inferenceBackend = "faceapi";
      log(`[insightface] unavailable, fallback=faceapi err=${String(err)}`);
    }
  }

  if (saveSnapshots) {
    await fsp.mkdir(snapshotDir, { recursive: true }).catch(() => {});
  }
  if (workerPreviewEnabled) {
    await fsp.mkdir(workerPreviewDir, { recursive: true }).catch(() => {});
  }
  if (faceArchiveEnabled) {
    await fsp.mkdir(faceArchiveDir, { recursive: true }).catch(() => {});
  }
  await fsp.mkdir(phantomSnapshotDir, { recursive: true }).catch(() => {});

  const faceApiFallbackEnabled = inferenceBackend === "faceapi" || allowFaceApiFallback;
  const modelDir = path.join(rootDir, "public", "models");
  if (!fs.existsSync(modelDir) && (faceApiFallbackEnabled || enableEmotions)) {
    log(`model dir not found: ${modelDir}`);
    process.exit(1);
  }

  log(
    `[boot] loading models backend=${inferenceBackend} fallback=${faceApiFallbackEnabled ? "on" : "off"} ` +
      `emotions=${enableEmotions ? "on" : "off"}`,
  );
  faceapi.tf.enableProdMode();
  const needTinyFaceDetector = faceApiFallbackEnabled || enableEmotions;
  if (needTinyFaceDetector) {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
    log("[boot] tiny-face-detector loaded");
  }
  let knownLabeledDescriptors = [];
  let blockedFaceIds = await loadBlockedFaceIds(blockedFaceIdsFile);
  let blockedDescriptorBank = [];
  let lastBlockedFaceIdsReloadAt = Date.now();
  let lastFaceRegistryReloadAt = 0;
  let ssdLoaded = false;
  if (faceApiFallbackEnabled && useSsdFallback) {
    try {
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
      ssdLoaded = true;
      log("[boot] ssd-mobilenet loaded");
    } catch (err) {
      log(`ssd fallback disabled (load failed): ${String(err)}`);
    }
  }
  const tinyOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: tinyInputSize,
    scoreThreshold: tinyScoreThreshold,
  });
  const emotionTinyOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: emotionTinyInputSize,
    scoreThreshold: emotionTinyScoreThreshold,
  });
  const ssdOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: ssdMinConfidence });
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
      blockedDescriptorBank = buildDescriptorBankFromBlockedIds(
        knownLabeledDescriptors,
        blockedFaceIds,
      );
      lastFaceRegistryReloadAt = loadedAt;
      if (reason) {
        log(
          `[faces] registry reload reason=${reason} count=${knownLabeledDescriptors.length} ` +
            `blocked_bank=${blockedDescriptorBank.length}`,
        );
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
  let lastInsightFaceErrLogAt = 0;
  let lastInsightFaceRestartAt = 0;
  let consecutiveInsightFaceFailures = 0;
  let lastInsightFaceFailureAt = 0;
  const analyzeWithInsightFace = async (
    {
      jpgBuffer,
      rgb,
      width,
      height,
    },
    { includeDescriptor = false, maxFaces = 10, minScore = 0 } = {},
  ) => {
    if (inferenceBackend !== "insightface") return null;
    if (!(rgb instanceof Uint8Array) || !rgb.length || !width || !height) return [];
    try {
      const payload = await postJsonExpectJsonWithTimeout(
        insightFaceAnalyzeEndpoint,
        {
          imageBase64: jpgBuffer instanceof Buffer && jpgBuffer.length ? toBase64(jpgBuffer) : "",
          rgbBase64: Buffer.from(rgb).toString("base64"),
          width,
          height,
          includeDescriptor,
          maxFaces,
          minScore,
        },
        insightFaceTimeoutMs,
      );
      consecutiveInsightFaceFailures = 0;
      lastInsightFaceFailureAt = 0;
      return normalizeInsightFaceResult(payload);
    } catch (err) {
      const current = Date.now();
      consecutiveInsightFaceFailures =
        current - lastInsightFaceFailureAt <= Math.max(15000, insightFaceTimeoutMs * 3)
          ? consecutiveInsightFaceFailures + 1
          : 1;
      lastInsightFaceFailureAt = current;
      if (current - lastInsightFaceErrLogAt >= 3000) {
        log(
          `[insightface] analyze failed count=${consecutiveInsightFaceFailures} err=${String(err)}`,
        );
        lastInsightFaceErrLogAt = current;
      }
      const canRestart =
        inferenceBackend === "insightface" &&
        consecutiveInsightFaceFailures >= 2 &&
        current - lastInsightFaceRestartAt >= Math.max(4000, insightFaceTimeoutMs * 2);
      if (
        canRestart &&
        !(await isInsightFaceServiceHealthy(`${insightFaceEndpointBase}/health`, Math.min(1500, insightFaceTimeoutMs)))
      ) {
        lastInsightFaceRestartAt = current;
        await restartInsightFaceService("analyze_fetch_failed");
      }
      return null;
    }
  };
  let lastEmotionFallbackErrLogAt = 0;
  const enrichDetectionsWithEmotionFallback = async (rgb, frameWidth, frameHeight, detections) => {
    if (!enableEmotions || !Array.isArray(detections) || !detections.length) return detections;
    try {
      for (const det of detections) {
        const detBox = getBox(det);
        if (!detBox) continue;
        // Crop the face region from the full rgb frame and run face-api on the crop.
        // This avoids tiny-face-detector failing to find faces in large 1920x1080 frames.
        const pad = Math.round(Math.max(detBox.width, detBox.height) * 0.35);
        const cx = Math.max(0, Math.floor(detBox.x - pad));
        const cy = Math.max(0, Math.floor(detBox.y - pad));
        const cw = Math.min(frameWidth - cx, Math.ceil(detBox.width + pad * 2));
        const ch = Math.min(frameHeight - cy, Math.ceil(detBox.height + pad * 2));
        if (cw < 32 || ch < 32) continue;
        // Extract crop from rgb (HWC uint8)
        const cropRgb = new Uint8Array(cw * ch * 3);
        for (let row = 0; row < ch; row++) {
          const srcRow = cy + row;
          if (srcRow >= frameHeight) break;
          for (let col = 0; col < cw; col++) {
            const srcCol = cx + col;
            if (srcCol >= frameWidth) continue;
            const srcIdx = (srcRow * frameWidth + srcCol) * 3;
            const dstIdx = (row * cw + col) * 3;
            cropRgb[dstIdx] = rgb[srcIdx];
            cropRgb[dstIdx + 1] = rgb[srcIdx + 1];
            cropRgb[dstIdx + 2] = rgb[srcIdx + 2];
          }
        }
        let cropTensor = null;
        try {
          cropTensor = faceapi.tf.tensor3d(cropRgb, [ch, cw, 3], "int32");
          let emotionDetections = await faceapi.detectAllFaces(cropTensor, emotionTinyOptions).withFaceExpressions();
          if ((!emotionDetections || !emotionDetections.length) && ssdLoaded) {
            emotionDetections = await faceapi.detectAllFaces(cropTensor, ssdOptions).withFaceExpressions();
          }
          if (!emotionDetections || !emotionDetections.length) {
            let singleDetection = await faceapi.detectSingleFace(cropTensor, emotionTinyOptions).withFaceExpressions();
            if (!singleDetection && ssdLoaded) {
              singleDetection = await faceapi.detectSingleFace(cropTensor, ssdOptions).withFaceExpressions();
            }
            emotionDetections = singleDetection ? [singleDetection] : [];
          }
          if (emotionDetections && emotionDetections.length) {
            // Pick the detection closest to crop center
            const cropCx = cw / 2;
            const cropCy = ch / 2;
            let best = null;
            let bestDist = Infinity;
            for (const ed of emotionDetections) {
              const eb = getBox(ed);
              if (!eb || !ed.expressions) continue;
              const dx = (eb.x + eb.width / 2) - cropCx;
              const dy = (eb.y + eb.height / 2) - cropCy;
              const dist = dx * dx + dy * dy;
              if (dist < bestDist) { bestDist = dist; best = ed; }
            }
            if (best?.expressions) {
              det.expressions = normalizeEmotionExpressions(best.expressions);
            }
          }
        } finally {
          cropTensor?.dispose?.();
        }
      }
      return detections;
    } catch (err) {
      const current = Date.now();
      if (current - lastEmotionFallbackErrLogAt >= 3000) {
        log(`[emotion-fallback] failed err=${String(err)}`);
        lastEmotionFallbackErrLogAt = current;
      }
      return detections;
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

  if (enableMatching && faceApiFallbackEnabled) {
    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(modelDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
  }
  if (enableMatching && inferenceBackend === "faceapi") {
    await reloadFaceRegistry("startup");
    log(
      `matching=on known=${knownLabeledDescriptors.length} threshold=${matchThreshold} ` +
        `min_margin=${matchMinMargin} min_face_px=${matchMinFaceSidePx} auto_create=${faceAutoCreate ? "on" : "off"} ` +
        `new_id_frames=${newIdConfirmFrames} new_id_min_score=${newIdMinScore.toFixed(3)} ` +
        `new_id_min_side=${newIdMinFaceSidePx} archive=${faceArchiveEnabled ? "on" : "off"}`,
    );
  } else if (enableMatching) {
    await reloadFaceRegistry("startup");
    log(
      `matching=on backend=insightface known=${knownLabeledDescriptors.length} threshold=${matchThreshold} ` +
        `min_margin=${matchMinMargin} min_face_px=${matchMinFaceSidePx} auto_create=${faceAutoCreate ? "on" : "off"} ` +
        `new_id_frames=${newIdConfirmFrames} new_id_min_score=${newIdMinScore.toFixed(3)} ` +
        `new_id_min_side=${newIdMinFaceSidePx} archive=${faceArchiveEnabled ? "on" : "off"}`,
    );
  } else {
    log("matching=off reason=env_disabled");
  }
  log(
    `blocked_ids file=${blockedFaceIdsFile} count=${blockedFaceIds.size} reload_ms=${blockedFaceIdsReloadMs}`,
  );
  log(
    `new_id_quality min_sharpness=${newIdMinSharpness.toFixed(2)} ` +
      `empty_min_sharpness=${newIdEmptyMinSharpness.toFixed(2)} blocked_bank_th=${phantomBankThreshold.toFixed(3)}`,
  );
  log(
    `ignore_zones cameras=${Object.keys(ignoreZonesByCamera).length} overlap=${ignoreZoneOverlapThreshold.toFixed(2)}`,
  );
  log(
    `auto_block=${autoBlockEnabled ? "on" : "off"} window_ms=${autoBlockWindowMs} ` +
      `min_samples=${autoBlockMinSamples} min_ratio=${autoBlockMinRatio.toFixed(2)} ` +
      `min_score=${autoBlockMinFaceScore.toFixed(3)} min_side=${autoBlockMinFaceSidePx} ` +
      `max_motion=${autoBlockMaxMotion.toFixed(2)}`,
  );
  log(
    `record_gate min_score=${recordMinFaceScore.toFixed(3)} min_side=${recordMinFaceSidePx} ` +
      `min_sharp=${recordMinSharpness.toFixed(2)} max_distance=${recordMaxDistance.toFixed(3)}`,
  );

  if (enableEmotions) {
    await faceapi.nets.faceExpressionNet.loadFromDisk(modelDir);
    log("[boot] face-expression loaded");
  } else {
    log("emotions=off reason=env_disabled");
  }

  if (inferenceBackend === "insightface") {
    log(
      `detector=insightface endpoint=${insightFaceEndpointBase} timeout_ms=${insightFaceTimeoutMs} ` +
        `emotion_fallback=${enableEmotions ? "face-api" : "off"} ` +
        `emotion_tiny(input=${emotionTinyInputSize},score=${emotionTinyScoreThreshold.toFixed(3)})`,
    );
  } else {
    log(
      `detector=face-api tiny(input=${tinyInputSize},score=${tinyScoreThreshold}) ` +
        `ssd_fallback=${ssdLoaded ? "on" : "off"}`,
    );
  }

  const states = cameras.map((c) => {
    const state = createState(c.cameraId, c.src);
    // Apply defaults once on startup; after that keep current zoom unless explicit override exists.
    state.workerZoom = clampWorkerZoom(workerZoomDefaults[c.cameraId] ?? 1, 1);
    state.workerOffsetY = clampFrameOffsetY(workerFrameOffsetDefaults[c.cameraId] ?? 0, 0);
    return state;
  });
  const autoBlockStatsByKey = new Map();
  const autoBlockLastTriggeredAt = new Map();
  let blockedIdsWriteLock = Promise.resolve();

  const persistBlockedIds = async () => {
    blockedIdsWriteLock = blockedIdsWriteLock
      .then(() => saveBlockedFaceIds(blockedFaceIdsFile, blockedFaceIds))
      .catch((err) => {
        log(`[auto-block] save blocked ids failed err=${String(err)}`);
      });
    await blockedIdsWriteLock;
  };

  const clearIdentityFromStates = (shortId) => {
    for (const state of states) {
      state.presenceSessions.delete(shortId);
      state.lastSeenMatchedAt.delete(shortId);
      state.lastDbSentAt.delete(`${state.cameraId}:${shortId}`);
      state.lastFaceArchiveAtByName.delete(shortId);
      state.lastFaceArchiveUrlByName.delete(shortId);
      state.emotionSeenAtByName.delete(shortId);
      state.emotionEmaByName.delete(shortId);
      if (Array.isArray(state.people) && state.people.length) {
        state.people = state.people.filter((person) => String(person?.name || "") !== shortId);
      }
      if (Array.isArray(state.matchedNames) && state.matchedNames.length) {
        state.matchedNames = state.matchedNames.filter((name) => String(name || "") !== shortId);
      }
    }
  };

  const maybeAutoBlockIdentity = async ({
    cam,
    person,
    now,
    quality,
    sourceJpg,
    windowMs,
    minSamples,
    minRatio,
    cooldownMs,
    enabled,
  }) => {
    if (!enabled) return false;
    const shortId = normalizeFaceShortId(person?.name);
    if (!shortId || isUnknownIdentity(shortId)) return false;
    if (blockedFaceIds.has(shortId)) return true;

    const key = `${cam.cameraId}:${shortId}`;
    let stat = autoBlockStatsByKey.get(key);
    if (!stat || now - stat.windowStartAt > windowMs) {
      stat = {
        windowStartAt: now,
        samples: 0,
        suspicious: 0,
        lastSeenAt: now,
      };
    }
    stat.samples += 1;
    if (quality.suspicious) stat.suspicious += 1;
    stat.lastSeenAt = now;
    autoBlockStatsByKey.set(key, stat);

    if (stat.samples < minSamples) return false;
    const ratio = stat.suspicious / Math.max(1, stat.samples);
    if (ratio < minRatio) return false;

    const lastTriggeredAt = Number(autoBlockLastTriggeredAt.get(shortId) || 0);
    if (now - lastTriggeredAt < cooldownMs) return true;

    blockedFaceIds.add(shortId);
    autoBlockLastTriggeredAt.set(shortId, now);
    clearIdentityFromStates(shortId);
    blockedDescriptorBank = buildDescriptorBankFromBlockedIds(
      knownLabeledDescriptors,
      blockedFaceIds,
    );
    await persistBlockedIds();

    let sourceSnapshotUrl = "";
    try {
      sourceSnapshotUrl = await savePhantomSnapshot(
        phantomSnapshotDir,
        phantomSnapshotPublicBase,
        cam.cameraId,
        sourceJpg,
        now,
      );
    } catch {
      sourceSnapshotUrl = "";
    }

    await writePhantomRejectionLog({
      cameraId: cam.cameraId,
      action: "auto_quarantine_blocked",
      reason:
        `РђРІС‚РѕР±Р»РѕРєРёСЂРѕРІРєР° ID: РїРѕРґРѕР·СЂРµРЅРёРµ РЅР° С„Р°РЅС‚РѕРј (ratio=${ratio.toFixed(2)}, ` +
        `samples=${stat.samples}, score=${Number(person?.faceScore ?? 0).toFixed(3)}, ` +
        `side=${Number(person?.faceSide ?? 0).toFixed(1)}, sharp=${Number(person?.faceSharpness ?? 0).toFixed(1)}).`,
      sourceSnapshotUrl,
      targetShortId: shortId,
      distance: Number(person?.distance ?? Number.NaN),
      threshold: minRatio,
    });

    log(
      `[${cam.cameraId}] auto_blocked shortId=${shortId} ratio=${ratio.toFixed(2)} ` +
        `samples=${stat.samples} suspicious=${stat.suspicious}`,
    );
    return true;
  };

  log(`started cameras=${states.length} frame_api=${frameApiBase}`);
  log(
    `pipeline parallel_cameras=${parallelCameraLimit} db_writer=${dbWriterMode} ` +
      `db_queue_max=${dbQueueMaxSize} db_batch=${dbQueueBatchSize} db_timeout_ms=${dbRequestTimeoutMs}`,
  );
  if (dbWriterMode === "external") {
    log(`db external queue file=${dbQueueFile}`);
  }
  log(
    `emotion min_confidence=${emotionMinConfidence} ema_alpha=${emotionEmaAlpha} ` +
      `ema_ttl_ms=${emotionEmaTtlMs} low_floor=${emotionLowConfidenceFloor} ` +
      `allow_low_label=${emotionAllowLowConfidenceLabel ? "on" : "off"} ` +
      `carryover_ms=${emotionCarryoverMs}`,
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
    if (insightFaceServiceChild && !insightFaceServiceChild.killed) {
      try {
        insightFaceServiceChild.kill("SIGTERM");
      } catch {
        // ignore shutdown errors
      }
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastHeartbeatAt = 0;
  let lastStatusAt = 0;
  let lastZoomReloadAt = 0;
  let workerZoomMap = {};
  const dbQueue = [];
  const enqueueDbQueueFile = createJsonlQueueWriter(dbQueueFile);
  let lastDbQueueWarnAt = 0;
  let lastLoopErrLogAt = 0;
  const emotionKeys = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];
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
    const camAmbiguousMarginFloor = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "ambiguousMarginFloor", ambiguousMarginFloor),
        ambiguousMarginFloor,
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
      250,
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
      0,
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
    const camNewIdEmptyMinScore = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "newIdEmptyMinScore", newIdEmptyMinScore),
          newIdEmptyMinScore,
        ),
      ),
    );
    const camNewIdEmptyMinFaceSidePx = Math.max(
      8,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "newIdEmptyMinFaceSidePx",
          newIdEmptyMinFaceSidePx,
        ),
        newIdEmptyMinFaceSidePx,
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
    const camNewIdMinSharpness = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "newIdMinSharpness", newIdMinSharpness),
        newIdMinSharpness,
      ),
    );
    const camNewIdEmptyMinSharpness = Math.max(
      camNewIdMinSharpness,
      parseFiniteFloat(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "newIdEmptyMinSharpness",
          newIdEmptyMinSharpness,
        ),
        newIdEmptyMinSharpness,
      ),
    );
    const camPhantomBankThreshold = Math.max(
      0.01,
      Math.min(
        2,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "phantomBankThreshold", phantomBankThreshold),
          phantomBankThreshold,
        ),
      ),
    );
    const camIdentifyMinIntervalMs = Math.max(
      400,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "identifyMinIntervalMs",
          identifyMinIntervalMs,
        ),
        identifyMinIntervalMs,
      ),
    );
    const camAutoCreateCooldownMs = Math.max(
      0,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "autoCreateCooldownMs",
          autoCreateCooldownMs,
        ),
        autoCreateCooldownMs,
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
    const camRecordMinFaceScore = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "recordMinFaceScore", recordMinFaceScore),
          recordMinFaceScore,
        ),
      ),
    );
    const camRecordMinFaceSidePx = Math.max(
      8,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "recordMinFaceSidePx", recordMinFaceSidePx),
        recordMinFaceSidePx,
      ),
    );
    const camRecordMinSharpness = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "recordMinSharpness", recordMinSharpness),
        recordMinSharpness,
      ),
    );
    const camRecordMaxDistance = Math.max(
      0.01,
      Math.min(
        2,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "recordMaxDistance", recordMaxDistance),
          recordMaxDistance,
        ),
      ),
    );
    const camIgnoreZonesRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "ignoreZones",
      ignoreZonesByCamera[cam.cameraId] || [],
    );
    const camIgnoreZones = Array.isArray(camIgnoreZonesRaw)
      ? camIgnoreZonesRaw.map((zone) => normalizeIgnoreZone(zone)).filter(Boolean)
      : [];
    const camIgnoreZoneOverlapThreshold = Math.max(
      0.05,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(
            cameraSettings,
            cam.cameraId,
            "ignoreZoneOverlapThreshold",
            ignoreZoneOverlapThreshold,
          ),
          ignoreZoneOverlapThreshold,
        ),
      ),
    );
    const camAutoBlockEnabledRaw = getCameraSetting(
      cameraSettings,
      cam.cameraId,
      "autoBlockEnabled",
      autoBlockEnabled,
    );
    const camAutoBlockEnabled =
      typeof camAutoBlockEnabledRaw === "boolean" ? camAutoBlockEnabledRaw : autoBlockEnabled;
    const camAutoBlockWindowMs = Math.max(
      60_000,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "autoBlockWindowMs", autoBlockWindowMs),
        autoBlockWindowMs,
      ),
    );
    const camAutoBlockMinSamples = Math.max(
      20,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "autoBlockMinSamples", autoBlockMinSamples),
        autoBlockMinSamples,
      ),
    );
    const camAutoBlockMinRatio = Math.max(
      0.5,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(cameraSettings, cam.cameraId, "autoBlockMinRatio", autoBlockMinRatio),
          autoBlockMinRatio,
        ),
      ),
    );
    const camAutoBlockMinFaceScore = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(
            cameraSettings,
            cam.cameraId,
            "autoBlockMinFaceScore",
            autoBlockMinFaceScore,
          ),
          autoBlockMinFaceScore,
        ),
      ),
    );
    const camAutoBlockMinFaceSidePx = Math.max(
      8,
      parseFiniteInt(
        getCameraSetting(
          cameraSettings,
          cam.cameraId,
          "autoBlockMinFaceSidePx",
          autoBlockMinFaceSidePx,
        ),
        autoBlockMinFaceSidePx,
      ),
    );
    const camAutoBlockMaxMotion = Math.max(
      0,
      parseFiniteFloat(
        getCameraSetting(cameraSettings, cam.cameraId, "autoBlockMaxMotion", autoBlockMaxMotion),
        autoBlockMaxMotion,
      ),
    );
    const camAutoBlockMinEmotionConfidence = Math.max(
      0,
      Math.min(
        1,
        parseFiniteFloat(
          getCameraSetting(
            cameraSettings,
            cam.cameraId,
            "autoBlockMinEmotionConfidence",
            autoBlockMinEmotionConfidence,
          ),
          autoBlockMinEmotionConfidence,
        ),
      ),
    );
    const camAutoBlockCooldownMs = Math.max(
      camAutoBlockWindowMs,
      parseFiniteInt(
        getCameraSetting(cameraSettings, cam.cameraId, "autoBlockCooldownMs", autoBlockCooldownMs),
        autoBlockCooldownMs,
      ),
    );
    const resetNewIdGate = () => {
      cam.newIdGateDescriptor = null;
      cam.newIdGateStreak = 0;
      cam.newIdGateLastAt = 0;
    };
    const confirmNewIdCandidate = (descriptor, faceSide, identityScore, faceSharpness = 0) => {
      if (!faceAutoCreate || !Array.isArray(descriptor) || !normalizeDescriptor(descriptor)) {
        resetNewIdGate();
        return false;
      }
      const noKnownIdentities = !Array.isArray(knownLabeledDescriptors) || knownLabeledDescriptors.length === 0;
      const effectiveMinScore = noKnownIdentities
        ? Math.max(camNewIdMinScore, camNewIdEmptyMinScore)
        : camNewIdMinScore;
      const effectiveMinFaceSide = noKnownIdentities
        ? Math.max(camNewIdMinFaceSidePx, camNewIdEmptyMinFaceSidePx)
        : camNewIdMinFaceSidePx;
      const effectiveMinSharpness = noKnownIdentities
        ? Math.max(camNewIdMinSharpness, camNewIdEmptyMinSharpness)
        : camNewIdMinSharpness;
      const effectiveConfirmFrames = noKnownIdentities
        ? camNewIdConfirmFrames
        : Math.max(2, camNewIdConfirmFrames);
      if (
        faceSide < effectiveMinFaceSide ||
        identityScore < effectiveMinScore ||
        faceSharpness < effectiveMinSharpness
      ) {
        resetNewIdGate();
        return false;
      }

      const prevDescriptor = Array.isArray(cam.newIdGateDescriptor) ? cam.newIdGateDescriptor : null;
      const withinGap = now - (cam.newIdGateLastAt || 0) <= camNewIdMaxGapMs;
      const stableDistance =
        prevDescriptor && prevDescriptor.length === descriptor.length
          ? Number(euclideanDistance(descriptor, prevDescriptor))
          : Number.POSITIVE_INFINITY;
      const isStable = withinGap && Number.isFinite(stableDistance) && stableDistance <= camNewIdStabilityMaxDistance;

      cam.newIdGateStreak = isStable ? cam.newIdGateStreak + 1 : 1;
      cam.newIdGateLastAt = now;
      cam.newIdGateDescriptor = descriptor.slice();
      return cam.newIdGateStreak >= effectiveConfirmFrames;
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
          (
            lockDistance <= 0 ||
            incomingDistance + camIdentityLockSwitchMargin < lockDistance ||
            incomingDistance <= Math.max(0, camMatchThreshold - 0.03)
          );

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
    const isRecordablePerson = (person) => {
      if (!person || isUnknownIdentity(person.name)) return false;
      if (person.lockOverridden) return false;
      const faceScore = Number(person.faceScore ?? 0);
      const faceSide = Number(person.faceSide ?? 0);
      const faceSharpness = Number(person.faceSharpness ?? 0);
      const distance = Number(person.distance ?? 0);
      if (faceScore < camRecordMinFaceScore) return false;
      if (faceSide < camRecordMinFaceSidePx) return false;
      if (faceSharpness < camRecordMinSharpness) return false;
      if (Number.isFinite(distance) && distance > 0 && distance > camRecordMaxDistance) return false;
      return true;
    };

    // Relaxed gate for already matched identities: avoid losing DB events when
    // frame quality fluctuates but identity is stable enough.
    const isRecordablePersonRelaxed = (person) => {
      if (!person || isUnknownIdentity(person.name)) return false;
      if (person.lockOverridden) return false;
      const faceScore = Number(person.faceScore ?? 0);
      const faceSide = Number(person.faceSide ?? 0);
      const faceSharpness = Number(person.faceSharpness ?? 0);
      const distance = Number(person.distance ?? 0);
      const minScore = Math.max(0.06, camRecordMinFaceScore - 0.04);
      const minSide = Math.max(12, camRecordMinFaceSidePx - 6);
      const minSharpness = Math.max(4, camRecordMinSharpness * 0.6);
      const maxDistance = Math.min(1, camRecordMaxDistance + 0.12);
      if (faceScore < minScore) return false;
      if (faceSide < minSide) return false;
      if (faceSharpness < minSharpness) return false;
      if (Number.isFinite(distance) && distance > 0 && distance > maxDistance) return false;
      return true;
    };

    const frameUrl = buildFrameUrl(frameApiBase, cam.src, frameApiTimeoutMs);
    const zoomOverride = Number(workerZoomMap?.[cam.cameraId]);
    if (Number.isFinite(zoomOverride)) {
      cam.workerZoom = clampWorkerZoom(zoomOverride, cam.workerZoom);
    } else {
      cam.workerZoom = clampWorkerZoom(cam.workerZoom, 1);
    }
    cam.workerOffsetY = clampFrameOffsetY(
      getCameraSetting(cameraSettings, cam.cameraId, "frameOffsetY", cam.workerOffsetY),
      cam.workerOffsetY,
    );
    if (!loggedCameraProfiles.has(cam.cameraId)) {
      loggedCameraProfiles.add(cam.cameraId);
      log(
        `[${cam.cameraId}] profile ` +
          `zoom=${cam.workerZoom.toFixed(2)} offset_y=${cam.workerOffsetY.toFixed(3)} confirm_frames=${camConfirmFrames} ` +
          `min_confirm=${camMinConfirmScore.toFixed(3)} filter_min=${camFilterMinScore.toFixed(3)} ` +
          `person_min=${camPersonMinScore.toFixed(3)} person_side=${camPersonMinSidePx} ` +
          `person_streak=${camPersonMinStreak} match_th=${camMatchThreshold.toFixed(3)} ` +
          `match_margin=${camMatchMinMargin.toFixed(3)} ambiguous_floor=${camAmbiguousMarginFloor.toFixed(3)} ` +
          `match_face_px=${camMatchMinFaceSidePx} ` +
          `identity_min=${camIdentityMinScore.toFixed(3)} frontal=${camRequireFrontalFace ? "on" : "off"} ` +
          `new_id_frames=${camNewIdConfirmFrames} new_id_min=${camNewIdMinScore.toFixed(3)} ` +
          `new_id_side=${camNewIdMinFaceSidePx} new_id_empty_min=${camNewIdEmptyMinScore.toFixed(3)} ` +
          `new_id_empty_side=${camNewIdEmptyMinFaceSidePx} new_id_sharp=${camNewIdMinSharpness.toFixed(2)} ` +
          `new_id_empty_sharp=${camNewIdEmptyMinSharpness.toFixed(2)} new_id_stability=${camNewIdStabilityMaxDistance.toFixed(3)} ` +
          `identify_cd=${camIdentifyMinIntervalMs} auto_create_cd=${camAutoCreateCooldownMs} ` +
          `lock_ms=${camIdentityLockMs} lock_margin=${camIdentityLockSwitchMargin.toFixed(3)} ` +
          `emotion_min=${camEmotionMinConfidence.toFixed(3)} emotion_floor=${camEmotionLowConfidenceFloor.toFixed(3)} ` +
          `db_reentry_ms=${camDbReentryGapMs} session_ms=${camSessionSnapshotIntervalMs} ` +
          `absence_ms=${camSessionAbsenceMs} resolve_ms=${camSessionResolveWaitMs} ` +
          `archive=${camFaceArchiveEnabled ? "on" : "off"} archive_cd=${camFaceArchiveCooldownMs} ` +
          `record_gate=${camRecordMinFaceScore.toFixed(3)}/${camRecordMinFaceSidePx}/${camRecordMinSharpness.toFixed(1)}/${camRecordMaxDistance.toFixed(3)} ` +
          `blocked_bank=${camPhantomBankThreshold.toFixed(3)} ignore_zones=${camIgnoreZones.length} ` +
          `auto_block=${camAutoBlockEnabled ? "on" : "off"} auto_block_samples=${camAutoBlockMinSamples}`,
      );
    }

    const isIdentityVisibleDetection = (det) =>
      isLikelyFrontalFace(det, {
        enabled: camRequireFrontalFace,
        minEyeDistanceRatio: camFrontalMinEyeDistanceRatio,
        maxEyeSlope: camFrontalMaxEyeSlope,
        noseCenterTolerance: camFrontalNoseCenterTolerance,
      });

    try {
      let jpg;
      try {
        jpg = await fetchFrame(frameUrl, frameTimeoutMs);
      } catch (err) {
        if (!frameAbortRetryEnabled || !isRetriableFrameError(err)) throw err;
        const retryUrl = buildAbortFallbackFrameUrl(
          frameUrl,
          frameAbortRetryWidth,
          frameAbortRetryHeight,
          frameAbortRetryQuality,
          frameAbortRetryApiTimeoutMs,
        );
        jpg = await fetchFrame(retryUrl, frameAbortRetryTimeoutMs);
      }
      const image = await decodeFrameImage(jpg, imageDecodeTimeoutMs);
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
      const cropYRange = Math.max(0, sourceHeight - workerHeight);
      const cropY = Math.max(
        0,
        Math.min(
          cropYRange,
          Math.floor(cropYRange / 2 - cam.workerOffsetY * cropYRange),
        ),
      );

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

      if (
        workerPreviewEnabled &&
        now - Number(cam.lastPreviewSavedAt || 0) >= workerPreviewIntervalMs
      ) {
        try {
          const previewBuffer = Buffer.from(
            canvas.toBuffer("image/jpeg", { quality: workerPreviewQuality }),
          );
          const previewFile = path.join(workerPreviewDir, `${cam.cameraId}.jpg`);
          await writeFileAtomic(previewFile, previewBuffer);
          cam.previewUrl = `${workerPreviewPublicBase}/${cam.cameraId}.jpg?v=${now}`;
          cam.lastPreviewSavedAt = now;
        } catch (err) {
          if (now - cam.lastErrLogAt >= 2000) {
            log(`[${cam.cameraId}] worker preview save error: ${String(err)}`);
            cam.lastErrLogAt = now;
          }
        }
      }

      const rgba = ctx.getImageData(0, 0, workerWidth, workerHeight).data;
      const rgb = rgbaToRgbTensorData(rgba);
      let frameTensorNumBefore = 0;
      try { frameTensorNumBefore = faceapi.tf.memory().numTensors; } catch (_) {}
      const frameTensor = faceapi.tf.tensor3d(rgb, [workerHeight, workerWidth, 3], "int32");

      let detections = [];
      try {
        if (inferenceBackend === "insightface") {
          const insightResults = await analyzeWithInsightFace({
            jpgBuffer: jpg,
            rgb,
            width: workerWidth,
            height: workerHeight,
          }, {
            includeDescriptor: false,
            maxFaces: 12,
            minScore: 0.05,
          });
          if (insightResults === null && allowFaceApiFallback) {
            detections = await faceapi.detectAllFaces(frameTensor, tinyOptions);
            if (!detections.length && ssdLoaded) {
              detections = await faceapi.detectAllFaces(frameTensor, ssdOptions);
            }
          } else {
            detections = insightResults || [];
          }
        } else {
          detections = await faceapi.detectAllFaces(frameTensor, tinyOptions);
          if (!detections.length && ssdLoaded) {
            detections = await faceapi.detectAllFaces(frameTensor, ssdOptions);
          }
        }
      } finally {
        const resized = faceapi.tf.image.resizeBilinear(frameTensor, [54, 96], true);
        const downsampled = await resized.data();
        resized.dispose();
        frameTensor.dispose();

        // Clean up any tensors that leaked during detection
        try {
          const numAfter = faceapi.tf.memory().numTensors;
          if (numAfter - frameTensorNumBefore > 20) {
            faceapi.tf.engine().startScope();
            faceapi.tf.engine().endScope();
          }
        } catch (_) {}

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
      if (camIgnoreZones.length) {
        detections = detections.filter(
          (det) =>
            !isDetectionIgnoredByZones(
              det,
              camIgnoreZones,
              workerWidth,
              workerHeight,
              camIgnoreZoneOverlapThreshold,
            ),
        );
      }
      if (camRequireFrontalFace && detections.length) {
        detections = detections.filter((det) => isIdentityVisibleDetection(det));
      }
      cam.candidate = detections.length;

      const { maxSide, maxScore } = largestFaceStats(detections);
      cam.score = maxScore;
      cam.maxFaceSide = maxSide;

      const best = detections[0];
      const bestBox = getBox(best);
      const currentBoxes = detections
        .map((det) => getBox(det))
        .filter(Boolean)
        .slice(0, 8);
      const trackStable = Boolean(
        currentBoxes.length &&
          cam.lastDetectionBoxes.length &&
          currentBoxes.some((box) => cam.lastDetectionBoxes.some((prevBox) => iou(box, prevBox) > 0.08)),
      );
      const similarCrowdSize =
        currentBoxes.length > 1 &&
        cam.lastDetectionBoxes.length > 0 &&
        Math.abs(currentBoxes.length - cam.lastDetectionBoxes.length) <= 1;
      if (bestBox) cam.lastBestBox = bestBox;
      if (!bestBox) cam.lastBestBox = null;
      cam.lastDetectionBoxes = currentBoxes;

      if (cam.candidate > 0) {
        cam.lastCandidateAt = now;
        if (trackStable || similarCrowdSize || cam.streak === 0) cam.streak += 1;
        else cam.streak = 1;
      } else {
        const candidateGapMs = now - Number(cam.lastCandidateAt || 0);
        const keepWarm = candidateGapMs <= Math.max(450, Math.floor(camMatchIntervalMs * 3));
        cam.streak = keepWarm ? Math.min(cam.streak, Math.max(1, camConfirmFrames - 1)) : 0;
        cam.lastDetectionBoxes = [];
      }

      const recentConfirm = now - cam.lastConfirmedAt < 2500;
      const wasConfirmed = cam.confirmed > 0;
      const motionGate =
        cam.motion >= camMotionThreshold || recentConfirm || maxScore >= 0.65 || maxSide >= 150;
      const isConfirmed =
        cam.candidate > 0 &&
        cam.streak >= camConfirmFrames &&
        maxScore >= camMinConfirmScore &&
        (fastPassMode ? true : motionGate);
      cam.confirmed = isConfirmed ? cam.candidate : 0;
      const confirmStarted = isConfirmed && !wasConfirmed;
      if (!isConfirmed) {
        cam.newIdGateDescriptor = null;
        cam.newIdGateStreak = 0;
        cam.newIdGateLastAt = 0;
        if (now - cam.lastConfirmedAt >= camRecognitionHoldMs) {
          cam.matchedNames = [];
          cam.matchDistance = 0;
          cam.people = [];
          cam.emotionSummary = "";
          cam.topEmotion = "";
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
      const needEmotionBase = enableEmotions && now - cam.lastEmotionAt >= camEmotionIntervalMs;
      const needEmotionOnConfirmStart = enableEmotions && confirmStarted;
      const needEmotionWhileConfirmed =
        enableEmotions &&
        isConfirmed &&
        now - cam.lastEmotionAt >= Math.max(120, Math.floor(camEmotionIntervalMs * 0.5));
      const needEmotion = needEmotionBase || needEmotionOnConfirmStart || needEmotionWhileConfirmed;
      const effectiveSnapshotCooldownMs = Math.max(
        camSnapshotCooldownMs,
        camSessionSnapshotIntervalMs,
      );
      const shouldSnapshot =
        cam.confirmed > 0 &&
        (needMatch || needEmotion) &&
        now - cam.lastSnapshotAt >= effectiveSnapshotCooldownMs;
      const needExpressionsForSnapshot = enableEmotions && (needEmotion || needMatch);

      if (shouldSnapshot) {
        cam.lastSnapshotAt = now;
        try {
          let results = [];
          let snapTensor = null;
          const runFaceApiDetect = async (options) => {
            let task = faceapi.detectAllFaces(snapTensor, options);
            if (enableMatching) {
              task = task.withFaceLandmarks(true).withFaceDescriptors();
            }
            if (needExpressionsForSnapshot) {
              task = task.withFaceExpressions();
            }
            return task;
          };

          try {
            if (inferenceBackend === "insightface") {
              const insightResults = await analyzeWithInsightFace({
                jpgBuffer: jpg,
                rgb,
                width: workerWidth,
                height: workerHeight,
              }, {
                includeDescriptor: enableMatching,
                maxFaces: 12,
                minScore: 0.05,
              });
              if (insightResults === null && allowFaceApiFallback) {
                snapTensor = faceapi.tf.tensor3d(rgb, [workerHeight, workerWidth, 3], "int32");
                results = await runFaceApiDetect(tinyOptions);
                if ((!results || !results.length) && ssdLoaded) {
                  results = await runFaceApiDetect(ssdOptions);
                }
              } else {
                results = insightResults || [];
              }
            } else {
              snapTensor = faceapi.tf.tensor3d(rgb, [workerHeight, workerWidth, 3], "int32");
              results = await runFaceApiDetect(tinyOptions);
              if ((!results || !results.length) && ssdLoaded) {
                results = await runFaceApiDetect(ssdOptions);
              }
            }
          } finally {
            snapTensor?.dispose?.();
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
          if (camIgnoreZones.length) {
            results = results.filter(
              (det) =>
                !isDetectionIgnoredByZones(
                  det,
                  camIgnoreZones,
                  workerWidth,
                  workerHeight,
                  camIgnoreZoneOverlapThreshold,
                ),
            );
          }
          if (inferenceBackend === "insightface" && needExpressionsForSnapshot && results.length) {
            results = await enrichDetectionsWithEmotionFallback(rgb, workerWidth, workerHeight, results);
          }
          if (camRequireFrontalFace && results.length) {
            results = results.filter((det) => isIdentityVisibleDetection(det));
          }

          const snapshotBase64 = jpg.toString("base64");
          const people = [];
          const descriptorByName = new Map();
          let bestDistance = 0;
          for (const det of results) {
            let name = "unknown";
            let distance = 0;
            let justRegistered = false;
            let faceSide = 0;
            let faceScore = 0;
            let faceSharpness = 0;
            let lockOverridden = false;
            const descriptor = descriptorToArray(det?.descriptor);
            if (enableMatching && descriptor) {
              faceSide = getFaceSide(det);
              faceScore = getScore(det);
              faceSharpness = estimateFaceSharpness(rgb, workerWidth, workerHeight, det);
              const identityScore = faceScore;
              const isFrontalFace = isIdentityVisibleDetection(det);
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
                const veryCloseBest = Boolean(bestCandidate) &&
                  bestCandidate.distance <= Math.max(0.2, camMatchThreshold - 0.06);
                const accepted =
                  Boolean(bestCandidate) &&
                  bestCandidate.distance <= camMatchThreshold &&
                  (margin >= camMatchMinMargin || veryCloseBest);
                const ambiguousNearMatch =
                  Boolean(bestCandidate) &&
                  bestCandidate.distance <= camMatchThreshold + 0.03 &&
                  margin < Math.max(camMatchMinMargin, camAmbiguousMarginFloor);
                if (ambiguousNearMatch && now - cam.lastAmbiguousLogAt >= 2000) {
                  log(
                    `[${cam.cameraId}] ambiguous_block best=${Number(bestCandidate?.distance ?? 0).toFixed(3)} ` +
                      `margin=${Number(margin).toFixed(3)} floor=${Math.max(camMatchMinMargin, camAmbiguousMarginFloor).toFixed(3)}`,
                  );
                  cam.lastAmbiguousLogAt = now;
                }
                const readyForNewId = confirmNewIdCandidate(
                  descriptor,
                  faceSide,
                  identityScore,
                  faceSharpness,
                );
                const softReadyForNewId =
                  faceSide >= Math.max(12, camNewIdMinFaceSidePx - 4) &&
                  identityScore >= Math.max(0.08, camNewIdMinScore - 0.03) &&
                  faceSharpness >= Math.max(4, camNewIdMinSharpness * 0.6);
                const canAttemptNewId = readyForNewId || softReadyForNewId;
                const blockedBankMatch = canAttemptNewId
                  ? findClosestDescriptorInBank(blockedDescriptorBank, descriptor)
                  : null;
                const blockedByPhantomBank = Boolean(
                  blockedBankMatch &&
                    Number(blockedBankMatch.distance) <= camPhantomBankThreshold,
                );

                let acceptedBlocked = false;
                if (accepted) {
                  const acceptedShortId = normalizeFaceShortId(bestCandidate.label);
                  if (acceptedShortId && blockedFaceIds.has(acceptedShortId)) {
                    acceptedBlocked = true;
                    resetNewIdGate();
                    if (now - cam.lastBlockedMatchLogAt >= 5000) {
                      log(`[${cam.cameraId}] blocked_id ignored shortId=${acceptedShortId}`);
                      cam.lastBlockedMatchLogAt = now;
                    }
                  } else {
                    resetNewIdGate();
                    name = bestCandidate.label;
                    distance = Number(bestCandidate.distance) || 0;
                    if (!bestDistance || distance < bestDistance) bestDistance = distance;
                  }
                }

                if ((!accepted || acceptedBlocked) && faceAutoCreate) {
                  const lockActive = cam.identityLockName && now < cam.identityLockUntil;
                  if (lockActive) {
                    name = cam.identityLockName;
                    distance = Number(cam.identityLockDistance) || 0;
                  } else if (canAttemptNewId && !blockedByPhantomBank && !ambiguousNearMatch) {
                    const identifyReady = now - (cam.lastIdentifyAt || 0) >= camIdentifyMinIntervalMs;
                    const autoCreateCoolingDown =
                      cam.lastAutoCreatedAt > 0 &&
                      now - cam.lastAutoCreatedAt < Math.max(camAutoCreateCooldownMs, 4500);
                    if (identifyReady && !autoCreateCoolingDown) {
                      cam.lastIdentifyAt = now;
                      const identified = await identifyFaceDescriptor(
                        descriptor,
                        camMatchThreshold,
                        snapshotBase64,
                      );
                      if (identified?.shortId) {
                        const identifiedShortId = normalizeFaceShortId(identified.shortId);
                        if (identifiedShortId && blockedFaceIds.has(identifiedShortId)) {
                          resetNewIdGate();
                          if (now - cam.lastBlockedMatchLogAt >= 5000) {
                            log(`[${cam.cameraId}] blocked_id ignored shortId=${identifiedShortId}`);
                            cam.lastBlockedMatchLogAt = now;
                          }
                        } else {
                          resetNewIdGate();
                          name = identified.shortId;
                          justRegistered = Boolean(identified.created);
                          if (Number.isFinite(identified.distance) && identified.distance > 0) {
                            distance = Number(identified.distance) || 0;
                            if (!bestDistance || distance < bestDistance) bestDistance = distance;
                          }
                          if (justRegistered) {
                            cam.lastAutoCreatedAt = now;
                            log(`[${cam.cameraId}] new_id created shortId=${name}`);
                          }
                        }
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
                lockOverridden = true;
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
            if (det?.expressions && process.env.WORKER_EMOTION_DEBUG === "1") {
              const exprStr = Object.entries(det.expressions)
                .map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(" ");
              log(`[${cam.cameraId}] emotion_raw ${exprStr} → key=${parsedEmotion.key} conf=${parsedEmotion.confidence.toFixed(3)}`);
            }
            let emotionKey = parsedEmotion.key;
            let emotionConfidence = parsedEmotion.confidence;
            if (emotionKey && Number.isFinite(emotionConfidence) && emotionConfidence > 0) {
              cam.lastRawEmotionKey = String(emotionKey || "").trim();
              cam.lastRawEmotionConfidence = Number(emotionConfidence);
              cam.lastRawEmotionAt = now;
            }
            if (emotionKey && !isUnknownIdentity(name)) {
              const prev = cam.emotionEmaByName.get(name);
              const smoothed = {};
              for (const key of emotionKeys) {
                const currentVal = Number(parsedEmotion.vector[key] ?? 0);
                const prevVal = Number(prev?.[key] ?? currentVal);
                const smoothingAlpha = key === "neutral"
                  ? camEmotionEmaAlpha
                  : Math.min(1, camEmotionEmaAlpha + 0.16);
                smoothed[key] = prev
                  ? smoothingAlpha * currentVal + (1 - smoothingAlpha) * prevVal
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
            const fallbackEmotionLabel =
              emotionKey && Number.isFinite(emotionConfidence) && emotionConfidence > 0
                ? `${emotionKey} ${(emotionConfidence * 100).toFixed(0)}%`
                : "";
            const recentRawEmotionUsable =
              !emotionLabel &&
              !fallbackEmotionLabel &&
              now - Number(cam.lastRawEmotionAt || 0) <= emotionCarryoverMs &&
              String(cam.lastRawEmotionKey || "").trim() &&
              Number(cam.lastRawEmotionConfidence || 0) >= camEmotionLowConfidenceFloor;
            const recentRawEmotionLabel = recentRawEmotionUsable
              ? `${cam.lastRawEmotionKey} ${(Number(cam.lastRawEmotionConfidence) * 100).toFixed(0)}%`
              : "";
            const displayEmotionLabel = emotionLabel || fallbackEmotionLabel || recentRawEmotionLabel;

            if (!isUnknownIdentity(name)) {
              people.push({
                name,
                emotion: displayEmotionLabel,
                emotionKey: emotionKey || "",
                emotionConfidence: Number(emotionConfidence.toFixed(4)),
                distance: Number(distance.toFixed(3)),
                faceScore: Number(faceScore.toFixed(4)),
                faceSide: Number(faceSide.toFixed(1)),
                faceSharpness: Number(faceSharpness.toFixed(2)),
                lockOverridden,
                justRegistered,
              });
            }
          }

          if (people.length) {
            const stablePeople = [];
            for (const person of people) {
              const shortId = normalizeFaceShortId(person?.name);
              if (!shortId || blockedFaceIds.has(shortId)) {
                continue;
              }
              const badScore = Number(person?.faceScore ?? 0) < camAutoBlockMinFaceScore;
              const badSide = Number(person?.faceSide ?? 0) < camAutoBlockMinFaceSidePx;
              const badEmotion =
                Number(person?.emotionConfidence ?? 0) < camAutoBlockMinEmotionConfidence;
              const badSharpness =
                Number(person?.faceSharpness ?? 0) < Math.max(6, camNewIdMinSharpness * 0.8);
              const badCount =
                (badScore ? 1 : 0) + (badSide ? 1 : 0) + (badEmotion ? 1 : 0) + (badSharpness ? 1 : 0);
              const suspicious = badCount >= 2 && cam.motion <= camAutoBlockMaxMotion;
              const blockedNow = await maybeAutoBlockIdentity({
                cam,
                person,
                now,
                sourceJpg: jpg,
                enabled: camAutoBlockEnabled,
                windowMs: camAutoBlockWindowMs,
                minSamples: camAutoBlockMinSamples,
                minRatio: camAutoBlockMinRatio,
                cooldownMs: camAutoBlockCooldownMs,
                quality: {
                  suspicious,
                },
              });
              if (!blockedNow && !blockedFaceIds.has(shortId)) {
                stablePeople.push(person);
              }
            }
            people.length = 0;
            people.push(...stablePeople);
          }


          cam.people = people;
          cam.matchedNames = people.map((p) => p.name);
          cam.matchDistance = people.length ? Number(bestDistance || 0) : 0;
          const matchedNamesNow = new Set(
            people.map((p) => p.name).filter((name) => !isUnknownIdentity(name)),
          );

          for (const [savedName, seenAt] of cam.emotionSeenAtByName.entries()) {
            if (now - seenAt > emotionEmaTtlMs) {
              if (matchedNamesNow.has(savedName)) continue;
              const savedAt = cam.lastSeenMatchedAt.get(savedName) ?? 0;
              if (now - Number(savedAt || 0) > dbSeenTtlMs) {
                cam.emotionSeenAtByName.delete(savedName);
                cam.emotionEmaByName.delete(savedName);
                cam.lastFaceArchiveAtByName.delete(savedName);
                cam.lastFaceArchiveUrlByName.delete(savedName);
              }
            }
          }

          cam.people = people;
          cam.matchedNames = people.map((p) => p.name);
          cam.matchDistance = people.length ? Number(bestDistance || 0) : 0;

          for (const matchedName of matchedNamesNow) {
            cam.lastSeenMatchedAt.set(matchedName, now);
          }
          for (const [savedName, seenAt] of cam.lastSeenMatchedAt.entries()) {
            if (!matchedNamesNow.has(savedName) && now - seenAt > dbSeenTtlMs) {
              cam.lastSeenMatchedAt.delete(savedName);
              cam.lastDbSentAt.delete(`${cam.cameraId}:${savedName}`);
              cam.lastFaceArchiveUrlByName.delete(savedName);
            }
          }
          evictPresenceSessions(cam, now, camSessionAbsenceMs, matchedNamesNow);
          if (people.length) {
            cam.lastRecognitionAt = now;
          }

          if (
            saveSnapshots &&
            people.length &&
            now - cam.lastSnapshotSavedAt >= Math.max(snapshotSaveCooldownMs, camSessionSnapshotIntervalMs)
          ) {
            try {
              let faceRect = null;
              if (bestBox) {
                const expanded = expandCropRect(bestBox, workerWidth, workerHeight, 0.18);
                if (expanded) {
                  faceRect = {
                    x: cropX + expanded.x,
                    y: cropY + expanded.y,
                    width: expanded.width,
                    height: expanded.height,
                  };
                }
              }
              const snapshotFile = path.join(snapshotDir, `${cam.cameraId}.jpg`);
              if (faceRect) {
                const croppedBuffer = await cropJpegBuffer(jpg, faceRect);
                if (croppedBuffer && croppedBuffer.length) {
                  await fsp.writeFile(snapshotFile, croppedBuffer);
                } else {
                  await fsp.writeFile(snapshotFile, jpg);
                }
              } else {
                await fsp.writeFile(snapshotFile, jpg);
              }
              cam.snapshotSavedCount = Number.isFinite(cam.snapshotSavedCount)
                ? cam.snapshotSavedCount + 1
                : 1;
              cam.snapshotUrl = `${snapshotPublicBase}/${cam.cameraId}.jpg?v=${now}`;
              cam.lastSnapshotSavedAt = now;
              const snapshotFaces = people
                .map((person) => `${person.name}:${person.emotion || person.emotionKey || "-"}`)
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
              if (blockedFaceIds.has(normalizeFaceShortId(person.name))) continue;
              const sessionKey = person.name;
              let session = cam.presenceSessions.get(sessionKey);
              if (!session) {
                session = createPresenceSession(now);
                cam.presenceSessions.set(sessionKey, session);
              }

              const strictRecordable = isRecordablePerson(person);
              const relaxedRecordable = isRecordablePersonRelaxed(person);
              const allowRelaxedRecord = Boolean(person.justRegistered) || (
                session.sampleCount >= Math.max(2, camSessionMinSamples) &&
                relaxedRecordable
              );
              if (!strictRecordable && !allowRelaxedRecord) {
                const lastSkipLogAt = Number(cam.lastRecordSkipLogAt || 0);
                if (now - lastSkipLogAt >= 2000) {
                  log(
                    `[${cam.cameraId}] record_skip name=${person.name} ` +
                      `score=${Number(person.faceScore ?? 0).toFixed(3)} ` +
                      `side=${Number(person.faceSide ?? 0).toFixed(1)} ` +
                      `sharp=${Number(person.faceSharpness ?? 0).toFixed(2)} ` +
                      `distance=${Number(person.distance ?? 0).toFixed(3)} ` +
                      `samples=${session.sampleCount} just_registered=${person.justRegistered ? "1" : "0"}`,
                  );
                  cam.lastRecordSkipLogAt = now;
                }
                continue;
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
              const readyByRegistration = Boolean(person.justRegistered);
              const canResolveFromSamples =
                session.sampleCount >= camSessionMinSamples &&
                sessionAgeMs >= camSessionResolveWaitMs &&
                (session.emotionSampleCount >= camSessionMinEmotionSamples || dbAllowMoodFallback);
              if (canResolveFromSamples) {
                const resolved = resolveSessionEmotionLabel({
                  session,
                  emotionKeys,
                  minConfidence: camEmotionMinConfidence,
                  lowConfidenceFloor: camEmotionLowConfidenceFloor,
                  allowLowConfidenceLabel: camEmotionAllowLowConfidenceLabel,
                  allowFallbackMood: dbAllowMoodFallback,
                  fallbackMood: dbFallbackMood,
                });
                moodLabel = resolved.moodLabel || moodLabel;
                if (resolved.emotionLabel) {
                  resolvedEmotionLabel = resolved.emotionLabel;
                }
                if (Number.isFinite(resolved.emotionConfidence)) {
                  resolvedEmotionConfidence = Number(resolved.emotionConfidence);
                }
              }

              if (!moodLabel && readyByRegistration && dbAllowMoodFallback) {
                moodLabel = dbFallbackMood;
              }
              // Keep recognition persistence robust: if session matured but
              // emotion label is still missing, emit with fallback mood.
              if (
                !moodLabel &&
                session.sampleCount >= camSessionMinSamples &&
                sessionAgeMs >= camSessionResolveWaitMs
              ) {
                moodLabel = dbFallbackMood;
              }
              if (!resolvedEmotionLabel && moodLabel) {
                resolvedEmotionLabel = moodLabel;
              }

              const readyBySession = canResolveFromSamples && Boolean(moodLabel);
              const shouldEmitSessionRecord =
                !session.emittedAt && (readyBySession || readyByRegistration);
              if (!shouldEmitSessionRecord) continue;

              const prevSeenAt = cam.lastSeenMatchedAt.get(person.name) ?? 0;
              const isReentry = prevSeenAt > 0 && now - prevSeenAt >= camDbReentryGapMs;

              const cooldownKey = `${cam.cameraId}:${person.name}`;
              const lastSent = cam.lastDbSentAt.get(cooldownKey) ?? 0;
              if (!isReentry && now - lastSent < dbCooldownMs) continue;

              if (!person.emotion && resolvedEmotionLabel) {
                person.emotion = resolvedEmotionLabel;
              }
              const effectiveEmotionLabel =
                String(person.emotion || "").trim() ||
                String(resolvedEmotionLabel || "").trim();
              cam.lastRecognitionMood = String(moodLabel || "").trim();
              cam.lastRecognitionEmotion = effectiveEmotionLabel;
              person.emotionConfidence = Number(
                Number.isFinite(resolvedEmotionConfidence)
                  ? resolvedEmotionConfidence
                  : Number(person.emotionConfidence ?? 0),
              );

              const dbPayload = {
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
                faceScore: Number(person.faceScore ?? 0),
                faceSide: Number(person.faceSide ?? 0),
                faceSharpness: Number(person.faceSharpness ?? 0),
                descriptor: descriptorByName.get(person.name) || undefined,
                snapshotUrl:
                  cam.lastFaceArchiveUrlByName.get(person.name) ||
                  cam.snapshotUrl ||
                  undefined,
              };

              if (dbWriterMode === "external") {
                try {
                  await enqueueDbQueueFile(dbPayload);
                } catch (err) {
                  if (now - lastDbQueueWarnAt >= 3000) {
                    log(`[db-queue] external enqueue failed: ${String(err)}`);
                    lastDbQueueWarnAt = now;
                  }
                  continue;
                }
              } else {
                if (dbQueue.length >= dbQueueMaxSize) {
                  dbQueue.shift();
                  if (now - lastDbQueueWarnAt >= 3000) {
                    log(`[db-queue] overflow: drop oldest, size=${dbQueue.length}`);
                    lastDbQueueWarnAt = now;
                  }
                }

                dbQueue.push(createDbQueueItem(dbPayload, now));
              }

              cam.lastDbSentAt.set(cooldownKey, now);
              session.emittedAt = now;
              session.lastMoodLabel = moodLabel;
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
                `${p.name}:${p.emotion || p.emotionKey || "-"}(${Number(p.emotionConfidence ?? 0).toFixed(2)})`,
              )
              .join(", ");
            const topExpressive = cam.people.find((person) => {
              const key = String(person?.emotionKey ?? "").trim().toLowerCase();
              const confidence = Number(person?.emotionConfidence ?? 0);
              return key && key !== "neutral" && Number.isFinite(confidence) && confidence >= camEmotionLowConfidenceFloor;
            });
            cam.topEmotion =
              String(topExpressive?.emotion ?? "").trim() ||
              String(topExpressive?.emotionKey ?? "").trim() ||
              cam.people.find((person) => String(person?.emotion ?? "").trim())?.emotion ||
              cam.people.find((person) => String(person?.emotionKey ?? "").trim())?.emotionKey ||
              "";
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
        evictPresenceSessions(cam, now, camSessionAbsenceMs, new Set());
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
      cam.identityLockName = "";
      cam.identityLockDistance = 0;
      cam.identityLockUntil = 0;
      evictPresenceSessions(cam, now, camSessionAbsenceMs, new Set());
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

  const processCameraWithTimeout = async (cam, now) => {
    if (cam.processing) {
      const elapsedMs = Math.max(0, now - Number(cam.processingStartedAt || 0));
      if (elapsedMs >= cameraProcessTimeoutMs && now - cam.lastErrLogAt >= 2000) {
        log(`[${cam.cameraId}] processing busy elapsed_ms=${elapsedMs}`);
        cam.lastErrLogAt = now;
      }
      return 0;
    }

    cam.processing = true;
    cam.processingStartedAt = now;
    const startedAt = now;

    const workPromise = Promise.resolve()
      .then(() => processCamera(cam, now))
      .finally(() => {
        if (cam.processingStartedAt === startedAt) {
          cam.processing = false;
          cam.processingStartedAt = 0;
          cam.processingTimedOutAt = 0;
        }
      });

    try {
      return await Promise.race([
        workPromise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`camera_process_timeout_${cameraProcessTimeoutMs}`)), cameraProcessTimeoutMs);
        }),
      ]);
    } catch (err) {
      cam.processingTimedOutAt = Date.now();
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
      cam.identityLockName = "";
      cam.identityLockDistance = 0;
      cam.identityLockUntil = 0;
      evictPresenceSessions(cam, now, camSessionAbsenceMs, new Set());
      cam.frameOk = false;
      cam.lastFrameError = String(err);
      if (now - cam.lastErrLogAt >= 2000) {
        log(`[${cam.cameraId}] camera timeout: ${String(err)}`);
        cam.lastErrLogAt = now;
      }
      return 0;
    }
  };

  let lastTfCleanupAt = Date.now();
  while (!stopping) {
    const now = Date.now();
    let confirmedTotal = 0;
    // Periodically clean up leaked TensorFlow.js tensors to prevent memory growth
    if (now - lastTfCleanupAt >= 10000) {
      try {
        faceapi.tf.engine().startScope();
        faceapi.tf.engine().endScope();
      } catch (_) {}
      lastTfCleanupAt = now;
    }
    try {
      if (now - lastZoomReloadAt >= workerZoomReloadMs) {
        workerZoomMap = await readWorkerZoomState(workerZoomStateFile);
        lastZoomReloadAt = now;
      }
      if (enableMatching && now - lastFaceRegistryReloadAt >= faceRegistryRefreshMs) {
        await reloadFaceRegistry("periodic");
      }
      if (now - lastBlockedFaceIdsReloadAt >= blockedFaceIdsReloadMs) {
        blockedFaceIds = await loadBlockedFaceIds(blockedFaceIdsFile);
        blockedDescriptorBank = buildDescriptorBankFromBlockedIds(
          knownLabeledDescriptors,
          blockedFaceIds,
        );
        lastBlockedFaceIdsReloadAt = now;
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
              confirmedTotal += await processCameraWithTimeout(current, now);
            }
          })(),
        );
      }
      await Promise.all(workers);

      if (dbWriterMode !== "external") {
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
          const camRecognitionHoldMs = Math.max(
            0,
            parseFiniteInt(
              getCameraSetting(cameraSettings, cam.cameraId, "recognitionHoldMs", recognitionHoldMs),
              recognitionHoldMs,
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
          const hasFace =
            cam.confirmed > 0 ||
            cam.candidate > 0 ||
            (now - cam.lastConfirmedAt < camRecognitionHoldMs &&
              (cam.people.length > 0 || cam.matchedNames.length > 0));
          const who = cam.matchedNames.length ? cam.matchedNames.join(", ") : "unknown";
          const emotion = cam.topEmotion || "none";
          const safeZoom = Number.isFinite(cam.workerZoom) ? cam.workerZoom : 1;
          const safeOffsetY = Number.isFinite(cam.workerOffsetY) ? cam.workerOffsetY : 0;
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
            workerOffsetY: Number(safeOffsetY.toFixed(3)),
            people: cam.people,
            emotionSummary: cam.emotionSummary,
            topEmotion: cam.topEmotion,
            lastRecognitionEmotion: cam.lastRecognitionEmotion,
            lastRecognitionMood: cam.lastRecognitionMood,
            previewUrl: cam.previewUrl,
            snapshotUrl: cam.snapshotUrl,
            snapshotSavedCount: Number.isFinite(cam.snapshotSavedCount) ? cam.snapshotSavedCount : 0,
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

  if (dbWriterMode !== "external" && dbQueue.length) {
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


