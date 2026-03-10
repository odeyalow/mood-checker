import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(raw: string | null, fallback = 100) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

async function getLatestDiskSnapshot(shortId: string) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return null;
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  let entries: Array<{ isFile: () => boolean; name: string }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name);
  if (!files.length) return null;

  const stats = await Promise.all(
    files.map(async (file) => {
      const abs = path.join(dir, file);
      const st = await fs.stat(abs).catch(() => null);
      return st
        ? {
            file,
            mtimeMs: st.mtimeMs,
          }
        : null;
    }),
  );
  const valid = stats.filter(Boolean) as { file: string; mtimeMs: number }[];
  if (!valid.length) return null;
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = valid[0];
  return {
    snapshotUrl: `/_faces/${safeId}/${top.file}`,
    detectedAt: new Date(top.mtimeMs).toISOString(),
  };
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

    const diskSnapshots = await Promise.all(
      identities.map(async (identity) => ({
        faceId: identity.id,
        disk: await getLatestDiskSnapshot(identity.shortId),
      })),
    );
    const diskByFaceId = new Map(diskSnapshots.map((item) => [item.faceId, item.disk]));

    const items = identities.map((identity) => {
      const latest = latestByFaceId.get(identity.id);
      const disk = diskByFaceId.get(identity.id);
      return {
        id: identity.id,
        shortId: identity.shortId,
        recognitionCount: identity._count.recognitions,
        snapshotUrl: latest?.snapshotUrl || disk?.snapshotUrl || "",
        lastDetectedAt: latest?.detectedAt?.toISOString() || disk?.detectedAt || "",
        createdAt: identity.createdAt.toISOString(),
      };
    });

    return NextResponse.json({ items });
  } catch (error) {
    console.error("[api/faces] GET failed", error);
    return NextResponse.json({ items: [], error: "faces_unavailable" });
  }
}
