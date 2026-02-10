import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 10) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), 10);
    const items = await prisma.recognition.findMany({
      orderBy: { detectedAt: "desc" },
      take: limit,
    });
    return NextResponse.json({ items });
  } catch (error) {
    console.error("[api/recognitions] GET failed", error);
    return NextResponse.json({ items: [], error: "recognitions_unavailable" });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    const mood = String(body?.mood ?? "").trim();
    const detectedAtRaw = body?.detectedAt ? new Date(body.detectedAt) : new Date();

    if (!name || !mood) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    const detectedAt = Number.isNaN(detectedAtRaw.getTime()) ? new Date() : detectedAtRaw;
    const item = await prisma.recognition.create({
      data: { name, mood, detectedAt },
    });

    return NextResponse.json({ item });
  } catch (error) {
    console.error("[api/recognitions] POST failed", error);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
