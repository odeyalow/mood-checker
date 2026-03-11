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

    const items = await prisma.faceDedupLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        action: true,
        reason: true,
        sourceShortId: true,
        targetShortId: true,
        sourceSnapshotUrl: true,
        targetSnapshotUrl: true,
        distance: true,
        threshold: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[api/faces/dedup-logs] GET failed", error);
    return NextResponse.json({ items: [], error: "dedup_logs_unavailable" }, { status: 500 });
  }
}

