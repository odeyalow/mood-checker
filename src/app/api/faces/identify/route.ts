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

function parseThreshold(raw: unknown) {
  const value = Number(raw ?? process.env.FACE_IDENTITY_MATCH_THRESHOLD ?? 0.56);
  if (!Number.isFinite(value)) return 0.56;
  return Math.max(0.2, Math.min(1, value));
}

function parsePostCheckThreshold(raw: unknown, baseThreshold: number) {
  const fallback = Math.min(1, baseThreshold + 0.04);
  const value = Number(raw ?? process.env.FACE_IDENTITY_POSTCHECK_THRESHOLD ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.2, Math.min(1, value));
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

async function createUniqueShortId(length: number) {
  for (let i = 0; i < 20; i += 1) {
    const candidate = generateFaceShortId(length);
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
    const postCheckThreshold = parsePostCheckThreshold(body?.postCheckThreshold, threshold);
    const updateAlpha = Number(process.env.FACE_IDENTITY_DESCRIPTOR_ALPHA ?? 0.2);
    const idLength = normalizeFaceIdLength(
      process.env.FACE_IDENTITY_ID_LENGTH ? Number(process.env.FACE_IDENTITY_ID_LENGTH) : 6,
    );
    const snapshotBuffer = parseSnapshotBuffer(body?.snapshotBase64);

    const identities = await prisma.faceIdentity.findMany({
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

    if (best && best.distance <= threshold) {
      const nextDescriptor = mergeDescriptor(best.descriptor, descriptor, updateAlpha);
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

    const shortId = await createUniqueShortId(idLength);
    const created = await prisma.faceIdentity.create({
      data: {
        shortId,
        descriptor,
      },
      select: { id: true, shortId: true, descriptor: true },
    });

    let sourceSnapshotUrl = "";
    if (snapshotBuffer) {
      sourceSnapshotUrl = await saveSnapshot(created.shortId, snapshotBuffer).catch(() => "");
    }

    const duplicateCandidate = ranked[0] ?? null;
    if (duplicateCandidate && duplicateCandidate.distance <= postCheckThreshold) {
      const targetSnapshotUrl = await getBestIdentitySnapshot(
        duplicateCandidate.id,
        duplicateCandidate.shortId,
      );
      const mergedDescriptor = mergeDescriptor(
        duplicateCandidate.descriptor,
        descriptor,
        updateAlpha,
      );

      await prisma.$transaction(async (tx) => {
        await tx.faceIdentity.update({
          where: { id: duplicateCandidate.id },
          data: { descriptor: mergedDescriptor },
        });

        await tx.recognition.updateMany({
          where: {
            OR: [{ faceIdentityId: created.id }, { name: created.shortId }],
          },
          data: {
            faceIdentityId: duplicateCandidate.id,
            name: duplicateCandidate.shortId,
          },
        });

        await tx.faceDedupLog.create({
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
            threshold: Number(postCheckThreshold.toFixed(6)),
          },
        });

        await tx.faceIdentity.delete({ where: { id: created.id } });
      });

      return NextResponse.json({
        shortId: duplicateCandidate.shortId,
        faceIdentityId: duplicateCandidate.id,
        created: false,
        merged: true,
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
