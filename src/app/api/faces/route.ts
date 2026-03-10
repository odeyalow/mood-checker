import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 100) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), 120);

    const identities = await prisma.faceIdentity.findMany({
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: {
        _count: {
          select: { recognitions: true },
        },
      },
    });

    const ids = identities.map((item) => item.id);
    const shortIds = identities.map((item) => item.shortId);
    const idByShortId = new Map(identities.map((item) => [item.shortId, item.id]));
    const latestWithSnapshot = ids.length
      ? await prisma.recognition.findMany({
          where: {
            OR: [
              { faceIdentityId: { in: ids } },
              { name: { in: shortIds } },
            ],
            snapshotUrl: { not: null },
          },
          orderBy: { detectedAt: "desc" },
          select: {
            faceIdentityId: true,
            name: true,
            snapshotUrl: true,
            detectedAt: true,
          },
          take: 5000,
        })
      : [];

    const latestByFaceId = new Map<
      string,
      { snapshotUrl: string | null; detectedAt: Date }
    >();
    for (const item of latestWithSnapshot) {
      const faceIdentityId =
        String(item.faceIdentityId ?? "") || String(idByShortId.get(String(item.name ?? "")) ?? "");
      if (!faceIdentityId || latestByFaceId.has(faceIdentityId)) continue;
      latestByFaceId.set(faceIdentityId, {
        snapshotUrl: item.snapshotUrl,
        detectedAt: item.detectedAt,
      });
    }

    const items = identities.map((identity) => {
      const latest = latestByFaceId.get(identity.id);
      return {
        id: identity.id,
        shortId: identity.shortId,
        recognitionCount: identity._count.recognitions,
        snapshotUrl: latest?.snapshotUrl || "",
        lastDetectedAt: latest?.detectedAt?.toISOString() || "",
        createdAt: identity.createdAt.toISOString(),
      };
    });

    return NextResponse.json({ items });
  } catch (error) {
    console.error("[api/faces] GET failed", error);
    return NextResponse.json({ items: [], error: "faces_unavailable" });
  }
}
