import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDescriptor } from "@/lib/faces";

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

function parseSnapshotBuffer(raw: unknown): Buffer | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const payload = trimmed.includes(",") ? trimmed.split(",").pop() || "" : trimmed;
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, "base64");
    if (!buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

async function saveSnapshot(faceShortId: string, buf: Buffer) {
  const safeId = faceShortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "face";
  const dirAbs = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.mkdir(dirAbs, { recursive: true });
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fileAbs = path.join(dirAbs, fileName);
  await fs.writeFile(fileAbs, buf);
  return `/_faces/${safeId}/${fileName}`;
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
    const snapshotBuffer = parseSnapshotBuffer(body?.snapshotBase64);
    const descriptor = normalizeDescriptor(body?.descriptor);
    const detectedAtRaw = body?.detectedAt ? new Date(body.detectedAt) : new Date();

    if (!name || !mood) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (isUnknownIdentity(name)) {
      return NextResponse.json({ ok: true, skipped: "unknown_identity" });
    }

    let snapshotUrl: string | null = null;
    if (snapshotBuffer) {
      try {
        snapshotUrl = await saveSnapshot(name, snapshotBuffer);
      } catch (error) {
        console.error("[api/recognitions] snapshot save failed", error);
      }
    }

    let faceIdentityId: string | null = null;
    try {
      let identity = await prisma.faceIdentity.findUnique({
        where: { shortId: name },
        select: { id: true },
      });
      if (!identity && descriptor) {
        try {
          identity = await prisma.faceIdentity.create({
            data: {
              shortId: name,
              descriptor,
            },
            select: { id: true },
          });
        } catch {
          identity = await prisma.faceIdentity.findUnique({
            where: { shortId: name },
            select: { id: true },
          });
        }
      }
      faceIdentityId = identity?.id ?? null;
    } catch {
      faceIdentityId = null;
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
      snapshotUrl,
      faceIdentityId,
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
