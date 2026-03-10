import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  descriptorDistance,
  generateFaceShortId,
  mergeDescriptor,
  normalizeDescriptor,
  normalizeFaceIdLength,
} from "@/lib/faces";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseThreshold(raw: unknown) {
  const value = Number(raw ?? process.env.FACE_IDENTITY_MATCH_THRESHOLD ?? 0.56);
  if (!Number.isFinite(value)) return 0.56;
  return Math.max(0.2, Math.min(1, value));
}

async function createUniqueShortId(length: number) {
  for (let i = 0; i < 20; i += 1) {
    const candidate = generateFaceShortId(length);
    const exists = await prisma.faceIdentity.findUnique({
      where: { shortId: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  return `${Date.now().toString(36).toUpperCase()}`.slice(-8);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const descriptor = normalizeDescriptor(body?.descriptor);
    if (!descriptor) {
      return NextResponse.json({ error: "invalid_descriptor" }, { status: 400 });
    }

    const threshold = parseThreshold(body?.threshold);
    const updateAlpha = Number(process.env.FACE_IDENTITY_DESCRIPTOR_ALPHA ?? 0.2);
    const idLength = normalizeFaceIdLength(process.env.FACE_IDENTITY_ID_LENGTH ? Number(process.env.FACE_IDENTITY_ID_LENGTH) : 6);

    const identities = await prisma.faceIdentity.findMany({
      select: { id: true, shortId: true, descriptor: true },
    });

    let best: { id: string; shortId: string; descriptor: number[]; distance: number } | null = null;
    for (const item of identities) {
      const known = normalizeDescriptor(item.descriptor);
      if (!known) continue;
      const distance = descriptorDistance(descriptor, known);
      if (!Number.isFinite(distance)) continue;
      if (!best || distance < best.distance) {
        best = { id: item.id, shortId: item.shortId, descriptor: known, distance };
      }
    }

    if (best && best.distance <= threshold) {
      const nextDescriptor = mergeDescriptor(best.descriptor, descriptor, updateAlpha);
      await prisma.faceIdentity.update({
        where: { id: best.id },
        data: { descriptor: nextDescriptor },
      });
      return NextResponse.json({
        shortId: best.shortId,
        faceIdentityId: best.id,
        created: false,
        distance: Number(best.distance.toFixed(6)),
        descriptor: nextDescriptor,
      });
    }

    const shortId = await createUniqueShortId(idLength);
    const created = await prisma.faceIdentity.create({
      data: {
        shortId,
        descriptor,
      },
      select: { id: true, shortId: true, descriptor: true },
    });

    return NextResponse.json({
      shortId: created.shortId,
      faceIdentityId: created.id,
      created: true,
      distance: null,
      descriptor: created.descriptor,
    });
  } catch (error) {
    console.error("[api/faces/identify] POST failed", error);
    return NextResponse.json({ error: "identify_failed" }, { status: 500 });
  }
}
