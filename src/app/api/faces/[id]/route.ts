import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
        faceIdentityId: face.id,
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
      where: { faceIdentityId: face.id },
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
