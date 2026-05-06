import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";
import {
  descriptorDistance,
  generateFaceShortId,
  mergeDescriptor,
  normalizeDescriptor,
  normalizeFaceIdLength,
} from "@/lib/faces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DUPLICATE_REASON = "Удалено, такое лицо уже существует в базе.";
const BLOCKED_IDS_FILE =
  process.env.WORKER_BLOCKED_FACE_IDS_FILE || path.join(process.cwd(), "worker", "blocked-face-ids.json");
const BLOCKED_IDS_RELOAD_MS = Math.max(
  1000,
  Number.parseInt(process.env.WORKER_BLOCKED_FACE_IDS_RELOAD_MS || "5000", 10) || 5000,
);
let blockedIdsCacheAt = 0;
let blockedIdsCache = new Set<string>();

function parseThreshold(raw: unknown) {
  const value = Number(raw ?? process.env.FACE_IDENTITY_MATCH_THRESHOLD ?? 0.56);
  if (!Number.isFinite(value)) return 0.56;
  return Math.max(0.2, Math.min(1, value));
}

function parseMatchMinMargin(raw: unknown) {
  const value = Number(raw ?? process.env.FACE_IDENTITY_MATCH_MIN_MARGIN ?? 0.1);
  if (!Number.isFinite(value)) return 0.1;
  return Math.max(0, Math.min(0.6, value));
}

function parseDescriptorUpdateStrictDistance(raw: unknown, threshold: number) {
  const fallback = Math.max(0.2, threshold - 0.04);
  const value = Number(raw ?? process.env.FACE_IDENTITY_UPDATE_MAX_DISTANCE ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.2, Math.min(1, value));
}

function parsePostCheckThreshold(raw: unknown, baseThreshold: number) {
  const fallback = Math.min(1, Math.max(0.58, baseThreshold + 0.02));
  const value = Number(raw ?? process.env.FACE_IDENTITY_POSTCHECK_THRESHOLD ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.2, Math.min(1, value));
}

function parsePostCheckRelaxedThreshold(raw: unknown, strictThreshold: number) {
  const fallback = Math.min(1, Math.max(0.62, strictThreshold + 0.04));
  const value = Number(raw ?? process.env.FACE_IDENTITY_POSTCHECK_RELAXED_THRESHOLD ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.2, Math.min(1, value));
}

function parsePostCheckWindowMs(raw: unknown) {
  const fallback = 2 * 60 * 1000;
  const value = Number(raw ?? process.env.FACE_IDENTITY_POSTCHECK_WINDOW_MS ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Math.floor(value)));
}

function parseBoolean(raw: unknown, fallback = false) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
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

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
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

async function saveSnapshot(shortId: string, buf: Buffer) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return "";
  const dirAbs = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.mkdir(dirAbs, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fileAbs = path.join(dirAbs, fileName);
  await fs.writeFile(fileAbs, buf);
  return `/_faces/${safeId}/${fileName}`;
}

function snapshotPathToPublicFile(snapshotUrl: string) {
  const clean = String(snapshotUrl || "").split("?")[0];
  if (!clean.startsWith("/")) return "";
  const rel = clean.replace(/^\/+/, "");
  const publicRoot = path.resolve(process.cwd(), "public");
  const abs = path.resolve(publicRoot, rel);
  if (!abs.startsWith(publicRoot)) return "";
  return abs;
}

async function snapshotExists(snapshotUrl: string | null | undefined) {
  if (!snapshotUrl) return false;
  const abs = snapshotPathToPublicFile(snapshotUrl);
  if (!abs) return false;
  try {
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

async function getLatestDiskSnapshot(shortId: string) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return "";
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  let entries: Array<{ isFile: () => boolean; name: string }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name);
  if (!files.length) return "";

  const stats = await Promise.all(
    files.map(async (file) => {
      const abs = path.join(dir, file);
      const st = await fs.stat(abs).catch(() => null);
      return st
        ? {
            file,
            mtimeMs: st.mtimeMs,
          }
        : null;
    }),
  );
  const valid = stats.filter(Boolean) as { file: string; mtimeMs: number }[];
  if (!valid.length) return "";
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return `/_faces/${safeId}/${valid[0].file}`;
}

async function getBestIdentitySnapshot(faceId: string, shortId: string) {
  const recent = await prisma.recognition.findMany({
    where: {
      OR: [{ faceIdentityId: faceId }, { name: shortId }],
      snapshotUrl: { not: null },
    },
    orderBy: { detectedAt: "desc" },
    take: 20,
    select: { snapshotUrl: true },
  });
  for (const item of recent) {
    const url = String(item.snapshotUrl ?? "");
    if (url && (await snapshotExists(url))) return url;
  }
  return getLatestDiskSnapshot(shortId);
}

async function createUniqueShortId(length: number, blockedIds: Set<string>) {
  for (let i = 0; i < 20; i += 1) {
    const candidate = generateFaceShortId(length);
    if (blockedIds.has(normalizeFaceShortId(candidate))) continue;
    const exists = await prisma.faceIdentity.findUnique({
      where: { shortId: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  return `${Date.now().toString(36).toUpperCase()}`.slice(-8);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const descriptor = normalizeDescriptor(body?.descriptor);
    if (!descriptor) {
      return NextResponse.json({ error: "invalid_descriptor" }, { status: 400 });
    }

    const threshold = parseThreshold(body?.threshold);
    const matchMinMargin = parseMatchMinMargin(body?.matchMinMargin);
    const descriptorUpdateMaxDistance = parseDescriptorUpdateStrictDistance(
      body?.descriptorUpdateMaxDistance,
      threshold,
    );
    const postCheckThreshold = parsePostCheckThreshold(body?.postCheckThreshold, threshold);
    const postCheckRelaxedThreshold = parsePostCheckRelaxedThreshold(
      body?.postCheckRelaxedThreshold,
      postCheckThreshold,
    );
    const postCheckWindowMs = parsePostCheckWindowMs(body?.postCheckWindowMs);
    const postCheckRelaxedEnabled = parseBoolean(
      body?.postCheckRelaxedEnabled ?? process.env.FACE_IDENTITY_POSTCHECK_RELAXED_ENABLED,
      false,
    );
    const updateAlpha = Number(process.env.FACE_IDENTITY_DESCRIPTOR_ALPHA ?? 0.2);
    const idLength = normalizeFaceIdLength(
      process.env.FACE_IDENTITY_ID_LENGTH ? Number(process.env.FACE_IDENTITY_ID_LENGTH) : 6,
    );
    const snapshotBuffer = parseSnapshotBuffer(body?.snapshotBase64);
    const blockedIds = await getBlockedFaceIds();
    const blockedList = Array.from(blockedIds);

    const identities = await prisma.faceIdentity.findMany({
      where: blockedList.length ? { shortId: { notIn: blockedList } } : undefined,
      select: { id: true, shortId: true, descriptor: true },
    });

    const ranked: Array<{ id: string; shortId: string; descriptor: number[]; distance: number }> = [];
    let best: { id: string; shortId: string; descriptor: number[]; distance: number } | null = null;
    for (const item of identities) {
      const known = normalizeDescriptor(item.descriptor);
      if (!known) continue;
      const distance = descriptorDistance(descriptor, known);
      if (!Number.isFinite(distance)) continue;
      ranked.push({ id: item.id, shortId: item.shortId, descriptor: known, distance });
      if (!best || distance < best.distance) {
        best = { id: item.id, shortId: item.shortId, descriptor: known, distance };
      }
    }
    ranked.sort((a, b) => a.distance - b.distance);

    const second = ranked[1] ?? null;
    const margin = second ? second.distance - (best?.distance ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    const acceptedBest = Boolean(best) && (best?.distance ?? Number.POSITIVE_INFINITY) <= threshold && margin >= matchMinMargin;

    if (best && acceptedBest) {
      const shouldUpdateDescriptor = best.distance <= descriptorUpdateMaxDistance;
      const nextDescriptor = shouldUpdateDescriptor
        ? mergeDescriptor(best.descriptor, descriptor, updateAlpha)
        : best.descriptor;
      await prisma.faceIdentity.update({
        where: { id: best.id },
        data: { descriptor: nextDescriptor },
      });
      return NextResponse.json({
        shortId: best.shortId,
        faceIdentityId: best.id,
        created: false,
        distance: Number(best.distance.toFixed(6)),
        descriptor: nextDescriptor,
      });
    }

    const shortId = await createUniqueShortId(idLength, blockedIds);
    const created = await prisma.faceIdentity.create({
      data: {
        shortId,
        descriptor,
      },
      select: { id: true, shortId: true, descriptor: true, createdAt: true },
    });

    let sourceSnapshotUrl = "";
    if (snapshotBuffer) {
      sourceSnapshotUrl = await saveSnapshot(created.shortId, snapshotBuffer).catch(() => "");
    }

    const postCheckCandidates = await prisma.faceIdentity.findMany({
      where: {
        id: { not: created.id },
        ...(blockedList.length ? { shortId: { notIn: blockedList } } : {}),
      },
      select: { id: true, shortId: true, descriptor: true, createdAt: true },
    });

    let duplicateCandidate:
      | {
          id: string;
          shortId: string;
          descriptor: number[];
          createdAt: Date;
          distance: number;
          margin: number;
        }
      | null = null;
    for (const item of postCheckCandidates) {
      const known = normalizeDescriptor(item.descriptor);
      if (!known) continue;
      const distance = descriptorDistance(descriptor, known);
      if (!Number.isFinite(distance)) continue;
      const competitor = ranked.find((candidate) => candidate.id !== item.id);
      const competitorDistance = Number(competitor?.distance ?? Number.POSITIVE_INFINITY);
      const candidateMargin = Number.isFinite(competitorDistance)
        ? Math.max(0, competitorDistance - distance)
        : Number.POSITIVE_INFINITY;
      if (
        !duplicateCandidate ||
        distance < duplicateCandidate.distance ||
        (distance === duplicateCandidate.distance && item.createdAt < duplicateCandidate.createdAt)
      ) {
        duplicateCandidate = {
          id: item.id,
          shortId: item.shortId,
          descriptor: known,
          createdAt: item.createdAt,
          distance,
          margin: candidateMargin,
        };
      }
    }

    const createdAtDeltaMs =
      duplicateCandidate && duplicateCandidate.createdAt
        ? Math.abs(created.createdAt.getTime() - duplicateCandidate.createdAt.getTime())
        : Number.POSITIVE_INFINITY;
    const mergeByStrict = Boolean(
      duplicateCandidate &&
        duplicateCandidate.distance <= postCheckThreshold &&
        duplicateCandidate.margin >= matchMinMargin,
    );
    const mergeByRelaxed = postCheckRelaxedEnabled && Boolean(
      duplicateCandidate &&
        createdAtDeltaMs <= postCheckWindowMs &&
        duplicateCandidate.distance <= postCheckRelaxedThreshold &&
        duplicateCandidate.margin >= Math.max(0.14, matchMinMargin + 0.03),
    );
    const shouldMerge = mergeByStrict || mergeByRelaxed;

    if (duplicateCandidate && shouldMerge && duplicateCandidate.createdAt <= created.createdAt) {
      const targetSnapshotUrl = await getBestIdentitySnapshot(duplicateCandidate.id, duplicateCandidate.shortId);
      const mergedDescriptor = mergeDescriptor(duplicateCandidate.descriptor, descriptor, updateAlpha);
      const usedThreshold = mergeByStrict ? postCheckThreshold : postCheckRelaxedThreshold;
      const mergeRule = mergeByStrict ? "strict" : "relaxed";

      await prisma.$transaction([
        prisma.faceIdentity.update({
          where: { id: duplicateCandidate.id },
          data: { descriptor: mergedDescriptor },
        }),
        prisma.recognition.updateMany({
          where: {
            OR: [{ faceIdentityId: created.id }, { name: created.shortId }],
          },
          data: {
            faceIdentityId: duplicateCandidate.id,
            name: duplicateCandidate.shortId,
          },
        }),
        prisma.faceDedupLog.create({
          data: {
            action: "deleted_duplicate",
            reason: DUPLICATE_REASON,
            sourceFaceId: created.id,
            sourceShortId: created.shortId,
            sourceSnapshotUrl: sourceSnapshotUrl || null,
            targetFaceId: duplicateCandidate.id,
            targetShortId: duplicateCandidate.shortId,
            targetSnapshotUrl: targetSnapshotUrl || null,
            distance: Number(duplicateCandidate.distance.toFixed(6)),
            threshold: Number(usedThreshold.toFixed(6)),
          },
        }),
        prisma.faceIdentity.delete({ where: { id: created.id } }),
      ]);

      return NextResponse.json({
        shortId: duplicateCandidate.shortId,
        faceIdentityId: duplicateCandidate.id,
        created: false,
        merged: true,
        mergeRule,
        distance: Number(duplicateCandidate.distance.toFixed(6)),
        descriptor: mergedDescriptor,
      });
    }

    return NextResponse.json({
      shortId: created.shortId,
      faceIdentityId: created.id,
      created: true,
      merged: false,
      distance: null,
      descriptor: created.descriptor,
    });
  } catch (error) {
    console.error("[api/faces/identify] POST failed", error);
    return NextResponse.json({ error: "identify_failed" }, { status: 500 });
  }
}
