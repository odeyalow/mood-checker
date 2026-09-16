import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeDescriptor, normalizeDescriptorList } from "@/lib/faces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 5000) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(20000, n));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const items = await prisma.faceIdentity.findMany({
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        shortId: true,
        descriptor: true,
        descriptors: true,
        createdAt: true,
        updatedAt: true,
      },
    });

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
      // Rows predating the template column have descriptors = null; fall back to
      // the single primary vector so the worker sees a one-entry template.
      const template = normalizeDescriptorList(item.descriptors);
      normalized.push({
        id: item.id,
        shortId: item.shortId,
        descriptor,
        descriptors: template.length ? template : [descriptor],
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
