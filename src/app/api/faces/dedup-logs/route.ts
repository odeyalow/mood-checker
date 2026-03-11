import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 100) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

function parseNullableString(raw: unknown, max = 255) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return value.slice(0, max);
}

function parseNullableFloat(raw: unknown) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
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

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = parseNullableString(body?.action, 64);
    const reason = parseNullableString(body?.reason, 500);

    if (!action || !reason) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    const created = await prisma.faceDedupLog.create({
      data: {
        action,
        reason,
        sourceFaceId: parseNullableString(body?.sourceFaceId, 64),
        sourceShortId: parseNullableString(body?.sourceShortId, 64),
        sourceSnapshotUrl: parseNullableString(body?.sourceSnapshotUrl, 600),
        targetFaceId: parseNullableString(body?.targetFaceId, 64),
        targetShortId: parseNullableString(body?.targetShortId, 64),
        targetSnapshotUrl: parseNullableString(body?.targetSnapshotUrl, 600),
        distance: parseNullableFloat(body?.distance),
        threshold: parseNullableFloat(body?.threshold),
      },
      select: {
        id: true,
        action: true,
        reason: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      ok: true,
      item: {
        ...created,
        createdAt: created.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("[api/faces/dedup-logs] POST failed", error);
    return NextResponse.json({ error: "dedup_log_create_failed" }, { status: 500 });
  }
}
