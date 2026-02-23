import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 10) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, n));
}

function isUnknownIdentity(name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === "unknown" ||
    normalized === "unrecognized" ||
    normalized === "not_recognized" ||
    normalized === "undefined" ||
    normalized === "null" ||
    normalized === "none" ||
    normalized === "n/a"
  );
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
    const cameraId = String(body?.cameraId ?? "").trim() || null;
    const distanceRaw = Number(body?.distance);
    const emotionConfidenceRaw = Number(body?.emotionConfidence);
    const workerZoomRaw = Number(body?.workerZoom);
    const frameWidthRaw = Number(body?.frameWidth);
    const frameHeightRaw = Number(body?.frameHeight);
    const detectedAtRaw = body?.detectedAt ? new Date(body.detectedAt) : new Date();

    if (!name || !mood) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (isUnknownIdentity(name)) {
      return NextResponse.json({ ok: true, skipped: "unknown_identity" });
    }

    const detectedAt = Number.isNaN(detectedAtRaw.getTime()) ? new Date() : detectedAtRaw;
    const data = {
      name,
      mood,
      detectedAt,
      cameraId,
      distance: Number.isFinite(distanceRaw) ? distanceRaw : null,
      emotionConfidence: Number.isFinite(emotionConfidenceRaw) ? emotionConfidenceRaw : null,
      workerZoom: Number.isFinite(workerZoomRaw) ? workerZoomRaw : null,
      frameWidth: Number.isFinite(frameWidthRaw) ? Math.round(frameWidthRaw) : null,
      frameHeight: Number.isFinite(frameHeightRaw) ? Math.round(frameHeightRaw) : null,
    };

    let item;
    try {
      item = await prisma.recognition.create({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const migrationMissing =
        message.includes("Unknown arg") ||
        message.includes("no such column") ||
        message.includes("does not exist");
      if (!migrationMissing) throw error;

      item = await prisma.recognition.create({
        data: { name, mood, detectedAt },
      });
    }

    return NextResponse.json({ item });
  } catch (error) {
    console.error("[api/recognitions] POST failed", error);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
