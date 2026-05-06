import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type LatestRecognitionMeta = {
  faceIdentityId: string;
  mood: string;
  cameraId: string;
  detectedAt: Date;
  snapshotUrl: string | null;
};

function parseLimit(raw: string | null, fallback = 100) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

function parseBool(raw: string | null, fallback = false) {
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

function isUnknownIdentity(name: string) {
  const normalized = String(name || "").trim().toLowerCase();
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
  if (!safeId) return null;
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  let entries: Array<{ isFile: () => boolean; name: string }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name);
  if (!files.length) return null;

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
  if (!valid.length) return null;
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = valid[0];
  return {
    snapshotUrl: `/_faces/${safeId}/${top.file}`,
    detectedAt: new Date(top.mtimeMs).toISOString(),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), 120);
    const includeEmpty = parseBool(url.searchParams.get("includeEmpty"), false);

    // Backfill identities for all recognition names that may have been
    // written when descriptor was missing. Using the full distinct name set
    // prevents the Faces page from only restoring very recent identities.
    const recentNames = await prisma.recognition.findMany({
      distinct: ["name"],
      select: { name: true },
    });
    const uniqueNames = Array.from(
      new Set(
        recentNames
          .map((row) => String(row.name || "").trim())
          .filter((name) => name && !isUnknownIdentity(name)),
      ),
    );
    for (const shortId of uniqueNames) {
      await prisma.faceIdentity
        .upsert({
          where: { shortId },
          create: { shortId, descriptor: [] },
          update: {},
          select: { id: true },
        })
        .catch(() => null);
    }

    const recognitionRows = await prisma.recognition.findMany({
      orderBy: { detectedAt: "desc" },
      take: Math.max(5000, limit * 50),
      select: {
        id: true,
        name: true,
        mood: true,
        cameraId: true,
        snapshotUrl: true,
        detectedAt: true,
      },
    });

    const latestRecognitionByShortId = new Map<
      string,
      {
        id: string;
        shortId: string;
        mood: string;
        cameraId: string;
        snapshotUrl: string | null;
        detectedAt: Date;
      }
    >();
    const recognitionCountByShortId = new Map<string, number>();
    for (const row of recognitionRows) {
      const shortId = String(row.name ?? "").trim();
      if (!shortId || isUnknownIdentity(shortId)) continue;
      recognitionCountByShortId.set(shortId, (recognitionCountByShortId.get(shortId) ?? 0) + 1);
      if (!latestRecognitionByShortId.has(shortId)) {
        latestRecognitionByShortId.set(shortId, {
          id: row.id,
          shortId,
          mood: String(row.mood ?? "").trim(),
          cameraId: String(row.cameraId ?? "").trim(),
          snapshotUrl: row.snapshotUrl,
          detectedAt: row.detectedAt,
        });
      }
    }

    const recognizedShortIds = Array.from(latestRecognitionByShortId.keys());
    const recognizedIdentities = recognizedShortIds.length
      ? await prisma.faceIdentity.findMany({
          where: { shortId: { in: recognizedShortIds } },
          select: {
            id: true,
            shortId: true,
            createdAt: true,
            _count: {
              select: { recognitions: true },
            },
          },
        })
      : [];
    const identityByShortId = new Map(recognizedIdentities.map((item) => [item.shortId, item]));

    const items: Array<{
      id: string;
      shortId: string;
      recognitionCount: number;
      snapshotUrl: string;
      lastDetectedAt: string;
      lastMood: string;
      lastCameraId: string;
      createdAt: string;
    }> = [];
    for (const shortId of recognizedShortIds) {
      if (items.length >= limit) break;
      const latest = latestRecognitionByShortId.get(shortId);
      if (!latest) continue;
      const identity = identityByShortId.get(shortId);
      const recognitionCount = recognitionCountByShortId.get(shortId) ?? identity?._count.recognitions ?? 0;
      if (!includeEmpty && recognitionCount <= 0) continue;
      const latestSnapshotOk = await snapshotExists(latest.snapshotUrl);
      const disk = await getLatestDiskSnapshot(shortId);
      items.push({
        id: identity?.id || `rec:${latest.id}`,
        shortId,
        recognitionCount,
        snapshotUrl: latestSnapshotOk ? latest.snapshotUrl || "" : disk?.snapshotUrl || "",
        lastDetectedAt: latestSnapshotOk
          ? latest.detectedAt.toISOString()
          : disk?.detectedAt || latest.detectedAt.toISOString(),
        lastMood: latest.mood || "",
        lastCameraId: latest.cameraId || "",
        createdAt: identity?.createdAt?.toISOString() || latest.detectedAt.toISOString(),
      });
    }

    if (includeEmpty && items.length < limit) {
      const usedShortIds = new Set(items.map((item) => item.shortId));
      const identities = await prisma.faceIdentity.findMany({
        orderBy: { updatedAt: "desc" },
        take: limit * 2,
        include: {
          _count: {
            select: { recognitions: true },
          },
        },
      });
      for (const identity of identities) {
        if (items.length >= limit) break;
        if (usedShortIds.has(identity.shortId)) continue;
        const disk = await getLatestDiskSnapshot(identity.shortId);
        items.push({
          id: identity.id,
          shortId: identity.shortId,
          recognitionCount: identity._count.recognitions ?? 0,
          snapshotUrl: disk?.snapshotUrl || "",
          lastDetectedAt: disk?.detectedAt || "",
          lastMood: "",
          lastCameraId: "",
          createdAt: identity.createdAt.toISOString(),
        });
      }
    }

    return NextResponse.json({ items });
  } catch (error) {
    console.error("[api/faces] GET failed", error);
    return NextResponse.json({ items: [], error: "faces_unavailable" });
  }
}
