import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeDescriptor } from "@/lib/faces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 5000) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(20000, n));
}

function galleryMaxSamples() {
  const n = Number.parseInt(process.env.FACE_GALLERY_MAX_SAMPLES || "", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 6;
}

// Loads up to K recent descriptor samples per identity. Fail-safe: if the
// FaceDescriptor table/client is missing (migration not applied yet), returns
// an empty map and the registry serves the centroid descriptor only.
async function loadGallery(): Promise<Map<string, number[][]>> {
  const byIdentity = new Map<string, number[][]>();
  const cap = galleryMaxSamples();
  try {
    const rows = await prisma.faceDescriptor.findMany({
      orderBy: { createdAt: "desc" },
      take: 20000,
      select: { faceIdentityId: true, descriptor: true },
    });
    for (const row of rows) {
      const descriptor = normalizeDescriptor(row.descriptor);
      if (!descriptor) continue;
      const arr = byIdentity.get(row.faceIdentityId) ?? [];
      if (arr.length >= cap) continue;
      arr.push(descriptor);
      byIdentity.set(row.faceIdentityId, arr);
    }
  } catch {
    return new Map();
  }
  return byIdentity;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const [items, gallery] = await Promise.all([
      prisma.faceIdentity.findMany({
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, shortId: true, descriptor: true, createdAt: true, updatedAt: true },
      }),
      loadGallery(),
    ]);

    const normalized: Array<{
      id: string;
      shortId: string;
      descriptor: number[];
      descriptors: number[][];
      createdAt: string;
      updatedAt: string;
    }> = [];
    for (const item of items) {
      const descriptor = normalizeDescriptor(item.descriptor);
      if (!descriptor) continue;
      const samples = gallery.get(item.id) ?? [];
      normalized.push({
        id: item.id,
        shortId: item.shortId,
        descriptor,
        descriptors: [descriptor, ...samples],
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      });
    }

    return NextResponse.json({ items: normalized });
  } catch (error) {
    console.error("[api/faces/registry] GET failed", error);
    return NextResponse.json({ items: [], error: "faces_registry_unavailable" });
  }
}
