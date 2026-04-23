import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDescriptor } from "@/lib/faces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RecognitionListItem = {
  id: string;
  name: string;
  mood: string;
  detectedAt: Date;
};

const BLOCKED_IDS_FILE =
  process.env.WORKER_BLOCKED_FACE_IDS_FILE || path.join(process.cwd(), "worker", "blocked-face-ids.json");
const BLOCKED_IDS_RELOAD_MS = Math.max(
  1000,
  Number.parseInt(process.env.WORKER_BLOCKED_FACE_IDS_RELOAD_MS || "5000", 10) || 5000,
);
let blockedIdsCacheAt = 0;
let blockedIdsCache = new Set<string>();
const qualityWindowByKey = new Map<
  string,
  { startedAt: number; suspiciousCount: number; totalCount: number; lastSeenAt: number }
>();

function parseLimit(raw: string | null, fallback = 10) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

function parseEnvInt(name: string, fallback: number) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvFloat(name: string, fallback: number) {
  const n = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(n) ? n : fallback;
}

function isUnknownIdentity(name: string) {
  const normalized = name.trim().toLowerCase();
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

function parseSnapshotBuffer(raw: unknown): Buffer | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const payload = trimmed.includes(",") ? trimmed.split(",").pop() || "" : trimmed;
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, "base64");
    if (!buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function parseSnapshotPublicUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const urlPath = trimmed.split("?")[0] || "";
  if (!urlPath.startsWith("/")) return null;
  if (!urlPath.startsWith("/_worker-snaps/") && !urlPath.startsWith("/_faces/")) return null;
  return urlPath;
}

function sanitizeShortId(shortId: string) {
  return String(shortId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
}

function normalizeFaceShortId(shortId: string) {
  return String(shortId || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

async function getBlockedFaceIds() {
  const now = Date.now();
  if (now - blockedIdsCacheAt <= BLOCKED_IDS_RELOAD_MS) return blockedIdsCache;
  try {
    const raw = await fs.readFile(BLOCKED_IDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
    const next = new Set<string>();
    for (const value of ids) {
      const id = normalizeFaceShortId(String(value || ""));
      if (id) next.add(id);
    }
    blockedIdsCache = next;
  } catch {
    blockedIdsCache = new Set();
  }
  blockedIdsCacheAt = now;
  return blockedIdsCache;
}

function normalizeSnapshotKey(url: string | null | undefined) {
  return String(url || "").split("?")[0].trim();
}

async function publicSnapshotExists(publicUrl: string) {
  const clean = normalizeSnapshotKey(publicUrl);
  if (!clean.startsWith("/")) return false;
  const publicRoot = path.resolve(process.cwd(), "public");
  const abs = path.resolve(publicRoot, clean.replace(/^\/+/, ""));
  if (!abs.startsWith(publicRoot)) return false;
  try {
    const stat = await fs.stat(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function saveSnapshot(faceShortId: string, buf: Buffer) {
  const safeId = faceShortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "face";
  const dirAbs = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.mkdir(dirAbs, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fileAbs = path.join(dirAbs, fileName);
  await fs.writeFile(fileAbs, buf);
  return `/_faces/${safeId}/${fileName}`;
}

async function saveSnapshotFromPublicUrl(faceShortId: string, publicUrl: string) {
  const relativePath = publicUrl.replace(/^\/+/, "");
  const publicRoot = path.resolve(process.cwd(), "public");
  const sourceAbs = path.resolve(publicRoot, relativePath);
  if (!sourceAbs.startsWith(publicRoot)) return null;
  const source = await fs.readFile(sourceAbs).catch(() => null);
  if (!source?.length) return null;
  return saveSnapshot(faceShortId, source);
}

async function saveSnapshotFromPublicUrlWithRetry(
  faceShortId: string,
  publicUrl: string,
  attempts = 3,
) {
  const tries = Math.max(1, attempts);
  for (let i = 0; i < tries; i += 1) {
    const snapshotUrl = await saveSnapshotFromPublicUrl(faceShortId, publicUrl).catch(() => null);
    if (snapshotUrl) return snapshotUrl;
    if (i < tries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), 10);
    const items = await prisma.recognition.findMany({
      orderBy: { detectedAt: "desc" },
      take: limit,
      select: {
        id: true,
        name: true,
        mood: true,
        detectedAt: true,
      },
    });

    const normalizedItems: RecognitionListItem[] = [];
    for (const item of items) {
      normalizedItems.push({
        id: item.id,
        name: String(item.name || "Unknown").trim() || "Unknown",
        mood: String(item.mood || "neutral").trim() || "neutral",
        detectedAt: item.detectedAt,
      });
    }

    return NextResponse.json({ items: normalizedItems });
  } catch (error) {
    console.error("[api/recognitions] GET failed", error);
    return NextResponse.json({ items: [], error: "recognitions_unavailable" });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    const mood = String(body?.mood ?? "").trim();
    const cameraId = String(body?.cameraId ?? "").trim() || null;
    const distanceRaw = Number(body?.distance);
    const emotionConfidenceRaw = Number(body?.emotionConfidence);
    const workerZoomRaw = Number(body?.workerZoom);
    const frameWidthRaw = Number(body?.frameWidth);
    const frameHeightRaw = Number(body?.frameHeight);
    const faceScoreRaw = Number(body?.faceScore);
    const faceSideRaw = Number(body?.faceSide);
    const faceSharpnessRaw = Number(body?.faceSharpness);
    const snapshotBuffer = parseSnapshotBuffer(body?.snapshotBase64);
    const snapshotPublicUrl = parseSnapshotPublicUrl(body?.snapshotUrl);
    const descriptor = normalizeDescriptor(body?.descriptor);
    const detectedAtRaw = body?.detectedAt ? new Date(body.detectedAt) : new Date();

    if (!name || !mood) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (isUnknownIdentity(name)) {
      return NextResponse.json({ ok: true, skipped: "unknown_identity" });
    }
    const blockedIds = await getBlockedFaceIds();
    if (blockedIds.has(normalizeFaceShortId(name))) {
      return NextResponse.json({ ok: true, skipped: "blocked_identity" });
    }

    const qualityGuardEnabled = String(process.env.RECOGNITION_QUALITY_GUARD_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false";
    if (qualityGuardEnabled) {
      const minFaceScore = Math.max(0, Math.min(1, parseEnvFloat("RECOGNITION_MIN_FACE_SCORE", 0.12)));
      const minFaceSidePx = Math.max(8, parseEnvInt("RECOGNITION_MIN_FACE_SIDE_PX", 20));
      const minFaceSharpness = Math.max(0, parseEnvFloat("RECOGNITION_MIN_FACE_SHARPNESS", 7));
      const windowMs = Math.max(30_000, parseEnvInt("RECOGNITION_SUSPICIOUS_WINDOW_MS", 5 * 60 * 1000));
      const maxSuspiciousPerWindow = Math.max(
        10,
        parseEnvInt("RECOGNITION_SUSPICIOUS_MAX_PER_WINDOW", 40),
      );
      const lowScore = Number.isFinite(faceScoreRaw) ? faceScoreRaw < minFaceScore : false;
      const lowSide = Number.isFinite(faceSideRaw) ? faceSideRaw < minFaceSidePx : false;
      const lowSharpness = Number.isFinite(faceSharpnessRaw) ? faceSharpnessRaw < minFaceSharpness : false;
      const suspicious = (lowScore ? 1 : 0) + (lowSide ? 1 : 0) + (lowSharpness ? 1 : 0) >= 2;

      const key = `${cameraId || "none"}:${name}`;
      const nowTs = Date.now();
      const prev = qualityWindowByKey.get(key);
      const active = prev && nowTs - prev.startedAt <= windowMs;
      const current = active
        ? {
            startedAt: prev.startedAt,
            suspiciousCount: prev.suspiciousCount + (suspicious ? 1 : 0),
            totalCount: prev.totalCount + 1,
            lastSeenAt: nowTs,
          }
        : {
            startedAt: nowTs,
            suspiciousCount: suspicious ? 1 : 0,
            totalCount: 1,
            lastSeenAt: nowTs,
          };
      qualityWindowByKey.set(key, current);

      if (suspicious && current.suspiciousCount > maxSuspiciousPerWindow) {
        console.warn(
          `[api/recognitions] quality_guard name=${name} camera=${cameraId || "none"} ` +
            `score=${Number.isFinite(faceScoreRaw) ? faceScoreRaw.toFixed(3) : "na"} ` +
            `side=${Number.isFinite(faceSideRaw) ? faceSideRaw.toFixed(1) : "na"} ` +
            `sharp=${Number.isFinite(faceSharpnessRaw) ? faceSharpnessRaw.toFixed(2) : "na"} ` +
            `window=${current.suspiciousCount}/${current.totalCount}`,
        );
        return NextResponse.json({
          ok: true,
          skipped: "quality_guard",
          quality: {
            lowScore,
            lowSide,
            lowSharpness,
            minFaceScore,
            minFaceSidePx,
            minFaceSharpness,
            suspiciousCount: current.suspiciousCount,
            totalCount: current.totalCount,
          },
        });
      }

      // Best-effort cleanup.
      if (qualityWindowByKey.size > 1500) {
        for (const [entryKey, entry] of qualityWindowByKey.entries()) {
          if (nowTs - entry.lastSeenAt > windowMs * 2) {
            qualityWindowByKey.delete(entryKey);
          }
        }
      }
    }

    let snapshotUrl: string | null = null;
    if (snapshotBuffer) {
      try {
        snapshotUrl = await saveSnapshot(name, snapshotBuffer);
      } catch (error) {
        console.error("[api/recognitions] snapshot save failed", error);
      }
    }
    if (!snapshotUrl && snapshotPublicUrl && snapshotPublicUrl.startsWith(`/_faces/${sanitizeShortId(name)}/`)) {
      const exists = await publicSnapshotExists(snapshotPublicUrl);
      if (exists) snapshotUrl = snapshotPublicUrl;
    }
    if (!snapshotUrl && snapshotPublicUrl) {
      try {
        snapshotUrl = await saveSnapshotFromPublicUrlWithRetry(name, snapshotPublicUrl, 3);
      } catch (error) {
        console.error("[api/recognitions] snapshot copy failed", error);
      }
    }
    if (!snapshotUrl && cameraId) {
      try {
        snapshotUrl = await saveSnapshotFromPublicUrlWithRetry(
          name,
          `/_worker-snaps/${cameraId}.jpg`,
          2,
        );
      } catch (error) {
        console.error("[api/recognitions] camera snapshot fallback failed", error);
      }
    }

    let faceIdentityId: string | null = null;
    try {
      let identity = await prisma.faceIdentity.findUnique({
        where: { shortId: name },
        select: { id: true },
      });
      if (!identity && descriptor) {
        try {
          identity = await prisma.faceIdentity.create({
            data: {
              shortId: name,
              descriptor,
            },
            select: { id: true },
          });
        } catch {
          identity = await prisma.faceIdentity.findUnique({
            where: { shortId: name },
            select: { id: true },
          });
        }
      }
      faceIdentityId = identity?.id ?? null;
    } catch {
      faceIdentityId = null;
    }

    const detectedAt = Number.isNaN(detectedAtRaw.getTime()) ? new Date() : detectedAtRaw;
    const dedupeMs = Math.max(
      500,
      Number.parseInt(process.env.RECOGNITION_DEDUP_MS || "1800", 10) || 1800,
    );
    const dedupeSince = new Date(detectedAt.getTime() - dedupeMs);
    const recent = await prisma.recognition.findFirst({
      where: {
        name,
        cameraId: cameraId ?? null,
        detectedAt: { gte: dedupeSince },
      },
      orderBy: { detectedAt: "desc" },
      select: {
        id: true,
        name: true,
        mood: true,
        detectedAt: true,
        snapshotUrl: true,
        faceIdentityId: true,
        emotionConfidence: true,
      },
    });
    if (recent) {
      const sameFace =
        (faceIdentityId && recent.faceIdentityId && faceIdentityId === recent.faceIdentityId) ||
        (!faceIdentityId && !recent.faceIdentityId);
      if (sameFace) {
        const sameMood = String(recent.mood || "") === mood;
        if (sameMood) {
          return NextResponse.json({ item: recent, deduped: true });
        }

        const recentConfidence = Number(recent.emotionConfidence ?? 0);
        const nextConfidence = Number.isFinite(emotionConfidenceRaw) ? emotionConfidenceRaw : 0;
        const shouldPromoteEmotion =
          nextConfidence >= recentConfidence ||
          (String(recent.mood || "") === "neutral" && mood !== "neutral");

        if (shouldPromoteEmotion) {
          try {
            const updated = await prisma.recognition.update({
              where: { id: recent.id },
              data: {
                mood,
                detectedAt,
                emotionConfidence: Number.isFinite(emotionConfidenceRaw) ? emotionConfidenceRaw : null,
              },
            });
            return NextResponse.json({ item: updated, deduped: true, updated: true });
          } catch {
            return NextResponse.json({ item: recent, deduped: true });
          }
        }

        return NextResponse.json({ item: recent, deduped: true });
      }
    }

    const data = {
      name,
      mood,
      detectedAt,
      cameraId,
      distance: Number.isFinite(distanceRaw) ? distanceRaw : null,
      emotionConfidence: Number.isFinite(emotionConfidenceRaw) ? emotionConfidenceRaw : null,
      workerZoom: Number.isFinite(workerZoomRaw) ? workerZoomRaw : null,
      frameWidth: Number.isFinite(frameWidthRaw) ? Math.round(frameWidthRaw) : null,
      frameHeight: Number.isFinite(frameHeightRaw) ? Math.round(frameHeightRaw) : null,
      snapshotUrl,
      faceIdentityId,
    };

    let item;
    try {
      item = await prisma.recognition.create({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const migrationMissing =
        message.includes("Unknown arg") ||
        message.includes("no such column") ||
        message.includes("does not exist");
      if (!migrationMissing) throw error;

      item = await prisma.recognition.create({
        data: { name, mood, detectedAt },
      });
    }

    return NextResponse.json({ item });
  } catch (error) {
    console.error("[api/recognitions] POST failed", error);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
