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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const items = await prisma.faceIdentity.findMany({
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, shortId: true, descriptor: true, createdAt: true, updatedAt: true },
    });

    const normalized = items
      .map((item) => {
        const descriptor = normalizeDescriptor(item.descriptor);
        if (!descriptor) return null;
        return {
          id: item.id,
          shortId: item.shortId,
          descriptor,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        };
      })
      .filter(Boolean);

    return NextResponse.json({ items: normalized });
  } catch (error) {
    console.error("[api/faces/registry] GET failed", error);
    return NextResponse.json({ items: [], error: "faces_registry_unavailable" });
  }
}
