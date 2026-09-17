import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Same file and shape the worker (loadBlockedFaceIds / saveBlockedFaceIds) and
// scripts/face-block.mjs use: { ids: [...], updatedAt }. The worker re-reads it
// every WORKER_BLOCKED_FACE_IDS_RELOAD_MS (5 s by default), so a block reaches
// the camera without a restart.
const BLOCKED_IDS_FILE =
  process.env.WORKER_BLOCKED_FACE_IDS_FILE || path.join(process.cwd(), "worker", "blocked-face-ids.json");

function normalizeFaceShortId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function sanitizeShortId(shortId: string) {
  return shortId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

async function readBlockedIds(): Promise<string[]> {
  try {
    const raw = await fs.readFile(BLOCKED_IDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
    const out = new Set<string>();
    for (const item of list) {
      const id = normalizeFaceShortId(item);
      if (id) out.add(id);
    }
    return Array.from(out).sort();
  } catch {
    return [];
  }
}

async function writeBlockedIds(ids: string[]) {
  const payload = {
    ids: Array.from(new Set(ids.map(normalizeFaceShortId).filter(Boolean))).sort(),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(BLOCKED_IDS_FILE), { recursive: true });
  // Write-then-rename so the worker never reads a half-written file.
  const tmp = `${BLOCKED_IDS_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, BLOCKED_IDS_FILE);
  return payload.ids;
}

async function removeFaceSnapshots(shortId: string) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return;
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function resolveFace(rawId: string) {
  const candidate = decodeURIComponent(rawId || "").trim();
  if (!candidate) return null;
  const byShortId = await prisma.faceIdentity.findUnique({
    where: { shortId: candidate },
    select: { id: true, shortId: true },
  });
  if (byShortId) return byShortId;
  return prisma.faceIdentity.findUnique({
    where: { id: candidate },
    select: { id: true, shortId: true },
  });
}

/**
 * Blocks an identity. This differs from DELETE in the one way that matters for
 * a false positive: deleting drops the descriptor, so the same non-face (a cap,
 * the back of a head, a poster) is enrolled again the next time the detector
 * fires on it. Blocking keeps the FaceIdentity row and lists its shortId in the
 * worker's blocked file; the worker then holds that descriptor in its blocked
 * bank and refuses to match or enrol anything close to it. The recognitions and
 * pictures are removed, so the card leaves the Faces page just like a deleted
 * one.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const face = await resolveFace(id);
    if (!face) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const shortId = normalizeFaceShortId(face.shortId);
    if (!shortId) {
      return NextResponse.json({ error: "invalid_short_id" }, { status: 400 });
    }

    const current = await readBlockedIds();
    const ids = await writeBlockedIds([...current, shortId]);

    const deletedRecognitions = await prisma.recognition.deleteMany({
      where: { OR: [{ faceIdentityId: face.id }, { name: face.shortId }] },
    });
    await removeFaceSnapshots(face.shortId);

    return NextResponse.json({
      ok: true,
      shortId: face.shortId,
      blocked: true,
      blockedCount: ids.length,
      deletedRecognitions: deletedRecognitions.count,
    });
  } catch (error) {
    console.error("[api/faces/[id]/block] POST failed", error);
    return NextResponse.json({ error: "block_failed" }, { status: 500 });
  }
}

/** Unblocks. The identity row was never removed, so it simply becomes matchable again. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const shortId = normalizeFaceShortId(decodeURIComponent(id || ""));
    if (!shortId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const current = await readBlockedIds();
    if (!current.includes(shortId)) {
      return NextResponse.json({ ok: true, shortId, blocked: false, changed: false });
    }
    const ids = await writeBlockedIds(current.filter((item) => item !== shortId));
    return NextResponse.json({ ok: true, shortId, blocked: false, changed: true, blockedCount: ids.length });
  } catch (error) {
    console.error("[api/faces/[id]/block] DELETE failed", error);
    return NextResponse.json({ error: "unblock_failed" }, { status: 500 });
  }
}
