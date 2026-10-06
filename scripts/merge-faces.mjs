#!/usr/bin/env node
/*
 * Merges one identity into another, by hand.
 *
 * Automatic merging is deliberately strict: folding two people into one is
 * irreversible and silent, so the pipeline would rather leave a duplicate.
 * The cost is that real duplicates have to be cleared manually — which is fine,
 * because a person looking at both galleries decides in a second what no
 * threshold can.
 *
 * Moves every recognition and picture onto the surviving identity, adds the
 * duplicate's vectors to its template so the angles it learned are not lost,
 * and records the merge in the dedup journal.
 *
 *   node scripts/merge-faces.mjs ABC123 --into XYZ789        # preview
 *   node scripts/merge-faces.mjs ABC123 --into XYZ789 --apply
 */
import "./load-env.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const intoIndex = args.indexOf("--into");
const positional = args.filter((a) => !a.startsWith("--") && a !== args[intoIndex + 1]);
const fromId = (positional[0] || "").trim().toUpperCase();
const intoId = (intoIndex >= 0 ? args[intoIndex + 1] || "" : "").trim().toUpperCase();

if (!fromId || !intoId) {
  process.stderr.write(
    "usage: node scripts/merge-faces.mjs <DUPLICATE_ID> --into <KEEP_ID> [--apply]\n",
  );
  process.exit(1);
}
if (fromId === intoId) {
  process.stderr.write("those are the same identity\n");
  process.exit(1);
}

function toUnit(raw) {
  if (!Array.isArray(raw) || raw.length !== 512) return null;
  const v = new Float64Array(512);
  let norm = 0;
  for (let i = 0; i < 512; i += 1) {
    const x = Number(raw[i]);
    if (!Number.isFinite(x)) return null;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  for (let i = 0; i < 512; i += 1) v[i] /= norm;
  return v;
}
const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < 512; i += 1) dot += a[i] * b[i];
  return 1 - dot;
};

/** Moves the duplicate's pictures into the survivor's folder. */
async function movePictures(from, into) {
  const safe = (id) => id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const fromDir = path.join(ROOT_DIR, "public", "_faces", safe(from));
  const intoDir = path.join(ROOT_DIR, "public", "_faces", safe(into));
  let names = [];
  try {
    const entries = await fs.readdir(fromDir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && /\.(jpe?g|png)$/i.test(e.name)).map((e) => e.name);
  } catch {
    return 0;
  }
  await fs.mkdir(intoDir, { recursive: true }).catch(() => {});
  let moved = 0;
  for (const name of names) {
    let target = name;
    try {
      await fs.access(path.join(intoDir, target));
      target = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
    } catch {
      // free
    }
    try {
      await fs.rename(path.join(fromDir, name), path.join(intoDir, target));
      moved += 1;
    } catch {
      // best effort
    }
  }
  await fs.rm(fromDir, { recursive: true, force: true }).catch(() => {});
  return moved;
}

async function main() {
  const [from, into] = await Promise.all([
    prisma.faceIdentity.findUnique({ where: { shortId: fromId } }),
    prisma.faceIdentity.findUnique({ where: { shortId: intoId } }),
  ]);
  if (!from) {
    process.stdout.write(`no identity ${fromId}\n`);
    return;
  }
  if (!into) {
    process.stdout.write(`no identity ${intoId}\n`);
    return;
  }

  const [fromRows, intoRows] = await Promise.all([
    prisma.recognition.count({ where: { OR: [{ faceIdentityId: from.id }, { name: fromId }] } }),
    prisma.recognition.count({ where: { OR: [{ faceIdentityId: into.id }, { name: intoId }] } }),
  ]);

  const a = toUnit(from.descriptor);
  const b = toUnit(into.descriptor);
  const distance = a && b ? cosine(a, b) : Number.NaN;

  process.stdout.write(`\n  ${fromId}  ${fromRows} recognitions   (will be removed)\n`);
  process.stdout.write(`  ${intoId}  ${intoRows} recognitions   (will keep everything)\n\n`);
  process.stdout.write(
    `  distance between them: ${Number.isFinite(distance) ? distance.toFixed(3) : "n/a"}\n`,
  );
  if (Number.isFinite(distance)) {
    process.stdout.write(
      distance > 0.75
        ? "  That is in the range of DIFFERENT people on this camera (0.80-1.05).\n" +
            "  Check both galleries before applying — this may not be a duplicate.\n"
        : "  Consistent with the same person seen under different conditions.\n",
    );
  }

  // The duplicate's vectors are angles of the same face, so they are worth
  // keeping — subject to the usual template limit.
  const fromVectors = [
    ...(Array.isArray(from.descriptors) ? from.descriptors : []),
    Array.isArray(from.descriptor) ? from.descriptor : null,
  ].filter((v) => Array.isArray(v) && v.length === 512);
  const intoVectors = Array.isArray(into.descriptors) && into.descriptors.length
    ? into.descriptors
    : [into.descriptor].filter((v) => Array.isArray(v) && v.length === 512);

  const { addToTemplate } = await import("file://" + path.join(ROOT_DIR, "src", "lib", "faces.ts").replace(/\\/g, "/"))
    .catch(() => ({ addToTemplate: null }));
  let nextTemplate = intoVectors;
  let added = 0;
  if (typeof addToTemplate === "function") {
    for (const vector of fromVectors) {
      const result = addToTemplate(nextTemplate, vector, { primary: into.descriptor });
      if (result) {
        nextTemplate = result;
        added += 1;
      }
    }
  }
  process.stdout.write(
    `  template: ${intoVectors.length} vector(s)` +
      (typeof addToTemplate === "function"
        ? ` + ${added} from the duplicate = ${nextTemplate.length}\n\n`
        : " (template merge unavailable without TypeScript support; vectors unchanged)\n\n"),
  );

  if (!apply) {
    process.stdout.write("  Nothing changed. Re-run with --apply.\n\n");
    return;
  }

  const moved = await movePictures(fromId, intoId);
  await prisma.$transaction([
    prisma.faceIdentity.update({
      where: { id: into.id },
      data: { descriptors: nextTemplate },
    }),
    prisma.recognition.updateMany({
      where: { OR: [{ faceIdentityId: from.id }, { name: fromId }] },
      data: { faceIdentityId: into.id, name: intoId },
    }),
    prisma.faceDedupLog.create({
      data: {
        action: "merged_manually",
        reason: "Объединено вручную оператором.",
        sourceFaceId: from.id,
        sourceShortId: fromId,
        targetFaceId: into.id,
        targetShortId: intoId,
        distance: Number.isFinite(distance) ? Number(distance.toFixed(6)) : null,
      },
    }),
    prisma.faceIdentity.delete({ where: { id: from.id } }),
  ]);

  process.stdout.write(
    `  Merged. ${fromRows} recognition(s) and ${moved} picture(s) moved to ${intoId}.\n` +
      "  The worker reloads the registry within WORKER_FACE_REGISTRY_REFRESH_MS (20 s).\n\n",
  );
}

main()
  .catch((error) => {
    process.stderr.write(`merge-faces failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
