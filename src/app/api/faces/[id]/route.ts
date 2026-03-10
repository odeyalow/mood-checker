import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
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

    const images = await prisma.recognition.findMany({
      where: {
        OR: [
          { faceIdentityId: face.id },
          { name: face.shortId },
        ],
        snapshotUrl: { not: null },
      },
      orderBy: { detectedAt: "desc" },
      take: 5,
      select: {
        id: true,
        mood: true,
        cameraId: true,
        detectedAt: true,
        snapshotUrl: true,
      },
    });

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
      images: images.map((item) => ({
        id: item.id,
        snapshotUrl: item.snapshotUrl || "",
        mood: item.mood,
        cameraId: item.cameraId || "",
        detectedAt: item.detectedAt.toISOString(),
      })),
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
