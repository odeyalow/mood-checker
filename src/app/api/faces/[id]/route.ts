import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type FaceRecognitionMeta = {
  id: string;
  mood: string;
  cameraId: string;
  detectedAt: string;
  snapshotUrl: string;
};

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
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

async function listDiskSnapshots(shortId: string, limit = 5) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return [];
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  let entries: Array<{ isFile: () => boolean; name: string }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name);
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
  return (stats.filter(Boolean) as { file: string; mtimeMs: number }[])
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, limit))
    .map((item, index) => ({
      id: `disk-${index}-${item.file}`,
      snapshotUrl: `/_faces/${safeId}/${item.file}`,
      mood: "",
      cameraId: "",
      detectedAt: new Date(item.mtimeMs).toISOString(),
    }));
}

function enrichDiskSnapshotsWithRecognitionMeta(diskItems: Array<{
  id: string;
  snapshotUrl: string;
  mood: string;
  cameraId: string;
  detectedAt: string;
}>, recognitionItems: FaceRecognitionMeta[]) {
  return diskItems.map((diskItem) => {
    const diskTs = new Date(diskItem.detectedAt).getTime();
    if (!Number.isFinite(diskTs)) return diskItem;
    let best: FaceRecognitionMeta | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const recognition of recognitionItems) {
      const recTs = new Date(recognition.detectedAt).getTime();
      if (!Number.isFinite(recTs)) continue;
      const diff = Math.abs(recTs - diskTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = recognition;
      }
    }
    if (!best) return diskItem;
    return {
      ...diskItem,
      mood: diskItem.mood || best.mood || "",
      cameraId: diskItem.cameraId || best.cameraId || "",
    };
  });
}

async function removeFaceSnapshots(shortId: string) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return;
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const shortId = decodeURIComponent(id || "").trim();
    if (!shortId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const face = await prisma.faceIdentity.findUnique({
      where: { shortId },
      select: {
        id: true,
        shortId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!face) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const recognitions = await prisma.recognition.findMany({
      where: {
        OR: [
          { faceIdentityId: face.id },
          { name: face.shortId },
        ],
      },
      orderBy: { detectedAt: "desc" },
      take: 200,
      select: {
        id: true,
        mood: true,
        cameraId: true,
        detectedAt: true,
        snapshotUrl: true,
      },
    });
    const recognitionItems: FaceRecognitionMeta[] = recognitions.map((item) => ({
      id: item.id,
      snapshotUrl: item.snapshotUrl || "",
      mood: String(item.mood || "").trim(),
      cameraId: String(item.cameraId || "").trim(),
      detectedAt: item.detectedAt.toISOString(),
    }));
    const images = recognitions.filter((item) => Boolean(item.snapshotUrl));
    const validImages = (
      await Promise.all(
        images.map(async (item) => ({
          item,
          ok: await snapshotExists(item.snapshotUrl),
        })),
      )
    )
      .filter((entry) => entry.ok)
      .map((entry) => entry.item);

    const diskFallback = enrichDiskSnapshotsWithRecognitionMeta(
      await listDiskSnapshots(face.shortId, 5),
      recognitionItems,
    );
    const dbImages = validImages.map((item) => ({
      id: item.id,
      snapshotUrl: item.snapshotUrl || "",
      mood: item.mood,
      cameraId: item.cameraId || "",
      detectedAt: item.detectedAt.toISOString(),
    }));
    const seen = new Set(dbImages.map((item) => item.snapshotUrl.split("?")[0]));
    const mergedImages = [...dbImages];
    for (const diskItem of diskFallback) {
      const clean = String(diskItem.snapshotUrl || "").split("?")[0];
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      mergedImages.push(diskItem);
    }
    mergedImages.sort(
      (a, b) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );
    const imagesOut = mergedImages.slice(0, 5);

    const recognitionCount = await prisma.recognition.count({
      where: {
        OR: [
          { faceIdentityId: face.id },
          { name: face.shortId },
        ],
      },
    });

    return NextResponse.json({
      face: {
        id: face.id,
        shortId: face.shortId,
        createdAt: face.createdAt.toISOString(),
        updatedAt: face.updatedAt.toISOString(),
        recognitionCount,
      },
      images: imagesOut,
    });
  } catch (error) {
    console.error("[api/faces/[id]] GET failed", error);
    return NextResponse.json({ error: "face_unavailable" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const shortId = decodeURIComponent(id || "").trim();
    if (!shortId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const face = await prisma.faceIdentity.findUnique({
      where: { shortId },
      select: { id: true, shortId: true },
    });
    if (!face) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const deletedRecognitions = await prisma.recognition.deleteMany({
      where: {
        OR: [{ faceIdentityId: face.id }, { name: face.shortId }],
      },
    });

    await prisma.faceIdentity.delete({ where: { id: face.id } });
    await removeFaceSnapshots(face.shortId);

    return NextResponse.json({
      ok: true,
      shortId: face.shortId,
      deletedRecognitions: deletedRecognitions.count,
    });
  } catch (error) {
    console.error("[api/faces/[id]] DELETE failed", error);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
