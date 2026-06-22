#!/usr/bin/env node
/*
 * Face registry deduplication.
 *
 * Finds FaceIdentity records whose descriptors are within a cosine-distance
 * threshold (i.e. very likely the same person registered multiple times) and
 * merges each cluster into one kept identity.
 *
 * SAFE BY DEFAULT: runs in preview (dry-run) mode and changes nothing.
 * Pass --apply to actually merge. BACK UP the DB first.
 *
 * Usage:
 *   node scripts/dedup-faces.mjs                       # preview, threshold 0.40
 *   node scripts/dedup-faces.mjs --threshold=0.38      # preview at a stricter threshold
 *   node scripts/dedup-faces.mjs --limit=30            # preview first 30 clusters
 *   node scripts/dedup-faces.mjs --apply               # MERGE (mutates DB)
 *
 * On merge, for every duplicate identity:
 *   - its Recognition rows are reassigned (faceIdentityId + name) to the kept identity,
 *   - its gallery samples (FaceDescriptor) are moved to the kept identity,
 *   - its centroid is added to the kept identity's gallery (preserves its face data),
 *   - a FaceDedupLog row is written,
 *   - the duplicate FaceIdentity is deleted.
 * The kept identity per cluster is the one with the most recognitions (oldest wins ties).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { apply: false, threshold: 0.4, limit: Number.POSITIVE_INFINITY };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--threshold=")) args.threshold = Number(a.slice("--threshold=".length));
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice("--limit=".length));
  }
  if (!Number.isFinite(args.threshold) || args.threshold <= 0) args.threshold = 0.4;
  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = Number.POSITIVE_INFINITY;
  return args;
}

function toUnitVector(raw) {
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

function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < 512; i += 1) dot += a[i] * b[i];
  return 1 - dot;
}

function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `[dedup] mode=${args.apply ? "APPLY (will mutate DB)" : "PREVIEW (dry-run)"} threshold=${args.threshold}\n`,
  );

  const identities = await prisma.faceIdentity.findMany({
    select: { id: true, shortId: true, descriptor: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  process.stdout.write(`[dedup] identities loaded=${identities.length}\n`);

  const recCounts = new Map();
  try {
    const grouped = await prisma.recognition.groupBy({
      by: ["faceIdentityId"],
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.faceIdentityId) recCounts.set(g.faceIdentityId, g._count._all);
    }
  } catch (err) {
    process.stdout.write(`[dedup] recognition count unavailable: ${String(err)}\n`);
  }

  const items = [];
  for (const it of identities) {
    const vec = toUnitVector(it.descriptor);
    if (!vec) continue;
    items.push({
      id: it.id,
      shortId: it.shortId,
      createdAt: it.createdAt,
      raw: it.descriptor,
      vec,
      rec: recCounts.get(it.id) || 0,
    });
  }
  process.stdout.write(`[dedup] with valid 512-dim descriptor=${items.length}\n`);

  const n = items.length;
  const uf = makeUnionFind(n);
  for (let i = 0; i < n; i += 1) {
    const vi = items[i].vec;
    for (let j = i + 1; j < n; j += 1) {
      if (cosineDistance(vi, items[j].vec) < args.threshold) uf.union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const plan = [];
  for (const idxs of clusters.values()) {
    if (idxs.length < 2) continue;
    const members = idxs.map((k) => items[k]);
    members.sort((a, b) => b.rec - a.rec || a.createdAt.getTime() - b.createdAt.getTime());
    plan.push({ keep: members[0], dups: members.slice(1) });
  }
  plan.sort((a, b) => b.dups.length - a.dups.length);

  const totalToRemove = plan.reduce((s, c) => s + c.dups.length, 0);
  process.stdout.write(
    `[dedup] duplicate clusters=${plan.length} identities_to_merge=${totalToRemove}\n\n`,
  );

  let shown = 0;
  for (const { keep, dups } of plan) {
    if (shown >= args.limit) {
      process.stdout.write(`... (${plan.length - shown} more clusters not shown)\n`);
      break;
    }
    shown += 1;
    const dupStr = dups
      .map((d) => `${d.shortId}[rec=${d.rec},d=${cosineDistance(keep.vec, d.vec).toFixed(3)}]`)
      .join(", ");
    process.stdout.write(`KEEP ${keep.shortId} (rec=${keep.rec}) <= ${dupStr}\n`);
  }

  if (!args.apply) {
    process.stdout.write(
      `\n[dedup] PREVIEW only — nothing changed.\n` +
        `        Review the clusters above. To merge: BACK UP prod.db, then re-run with --apply.\n`,
    );
    return;
  }

  process.stdout.write(`\n[dedup] applying merges...\n`);
  let merged = 0;
  for (const { keep, dups } of plan) {
    for (const d of dups) {
      const dist = Number(cosineDistance(keep.vec, d.vec).toFixed(6));
      try {
        await prisma.$transaction([
          prisma.recognition.updateMany({
            where: { OR: [{ faceIdentityId: d.id }, { name: d.shortId }] },
            data: { faceIdentityId: keep.id, name: keep.shortId },
          }),
          prisma.faceDescriptor.updateMany({
            where: { faceIdentityId: d.id },
            data: { faceIdentityId: keep.id },
          }),
          prisma.faceDescriptor.create({
            data: { faceIdentityId: keep.id, descriptor: d.raw },
          }),
          prisma.faceDedupLog.create({
            data: {
              action: "merged_duplicate",
              reason: `Дедуп реестра: слияние дубликата ${d.shortId} → ${keep.shortId} (dist=${dist}).`,
              sourceFaceId: d.id,
              sourceShortId: d.shortId,
              targetFaceId: keep.id,
              targetShortId: keep.shortId,
              distance: dist,
              threshold: args.threshold,
            },
          }),
          prisma.faceIdentity.delete({ where: { id: d.id } }),
        ]);
        merged += 1;
      } catch (err) {
        process.stderr.write(`[dedup] merge failed ${d.shortId} -> ${keep.shortId}: ${String(err)}\n`);
      }
    }
  }
  process.stdout.write(
    `\n[dedup] DONE merged=${merged} identities. ` +
      `Restart the worker to reload the registry: pm2 restart mood-checker-worker\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`dedup-faces failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
