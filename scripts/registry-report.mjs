#!/usr/bin/env node
/*
 * Read-only analysis of the face registry & recognitions.
 *
 * Changes NOTHING. Reports the numbers we need to redesign matching from data
 * instead of guessing thresholds on the live camera:
 *   - how many identities are near-duplicates (would merge at various thresholds),
 *   - the nearest-neighbour distance distribution (to pick a real match threshold),
 *   - how much "junk" there is (identities seen only once — usually bad-pose glimpses),
 *   - recognitions-per-identity distribution.
 *
 * Usage:
 *   node scripts/registry-report.mjs
 *   node scripts/registry-report.mjs --top=20        # show N largest duplicate clusters
 */

// Must come first: PrismaClient needs DATABASE_URL from .env.
import "./load-env.mjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { top: 12 };
  for (const a of argv) {
    if (a.startsWith("--top=")) args.top = Math.max(1, Number(a.slice(6)) || 12);
  }
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

function bar(count, max, width = 30) {
  if (max <= 0) return "";
  return "█".repeat(Math.round((count / max) * width));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const identities = await prisma.faceIdentity.findMany({
    select: { id: true, shortId: true, descriptor: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const totalRecognitions = await prisma.recognition.count();

  const recCounts = new Map();
  try {
    const grouped = await prisma.recognition.groupBy({
      by: ["faceIdentityId"],
      _count: { _all: true },
    });
    for (const g of grouped) if (g.faceIdentityId) recCounts.set(g.faceIdentityId, g._count._all);
  } catch {
    /* ignore */
  }

  const items = [];
  for (const it of identities) {
    const vec = toUnitVector(it.descriptor);
    if (!vec) continue;
    items.push({ id: it.id, shortId: it.shortId, vec, rec: recCounts.get(it.id) || 0 });
  }
  const n = items.length;

  process.stdout.write("\n===== REGISTRY REPORT =====\n");
  process.stdout.write(`identities:            ${identities.length}\n`);
  process.stdout.write(`  with 512-d vector:   ${n}\n`);
  process.stdout.write(`recognitions total:    ${totalRecognitions}\n\n`);

  // Recognitions per identity.
  let seenOnce = 0;
  let seenNever = 0;
  for (const it of items) {
    if (it.rec === 0) seenNever += 1;
    else if (it.rec === 1) seenOnce += 1;
  }
  process.stdout.write("--- recognitions per identity ---\n");
  process.stdout.write(`  0 recognitions (orphan): ${seenNever}\n`);
  process.stdout.write(`  exactly 1 (likely junk): ${seenOnce}\n`);
  process.stdout.write(`  2+ (established):        ${n - seenOnce - seenNever}\n\n`);

  if (n < 2) {
    process.stdout.write("Not enough vectors to analyse duplicates.\n");
    return;
  }

  // Nearest-neighbour distance for each identity + duplicate clustering.
  const nnBuckets = [0, 0, 0, 0, 0, 0]; // <0.2, .2-.3, .3-.4, .4-.5, .5-.6, >=.6
  const thresholds = [0.35, 0.45, 0.55];
  const ufs = thresholds.map(() => makeUnionFind(n));

  for (let i = 0; i < n; i += 1) {
    let nn = Number.POSITIVE_INFINITY;
    const vi = items[i].vec;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const d = cosineDistance(vi, items[j].vec);
      if (d < nn) nn = d;
      if (j > i) {
        for (let t = 0; t < thresholds.length; t += 1) {
          if (d < thresholds[t]) ufs[t].union(i, j);
        }
      }
    }
    if (nn < 0.2) nnBuckets[0] += 1;
    else if (nn < 0.3) nnBuckets[1] += 1;
    else if (nn < 0.4) nnBuckets[2] += 1;
    else if (nn < 0.5) nnBuckets[3] += 1;
    else if (nn < 0.6) nnBuckets[4] += 1;
    else nnBuckets[5] += 1;
  }

  const maxB = Math.max(...nnBuckets);
  const labels = ["<0.20", "0.20-0.30", "0.30-0.40", "0.40-0.50", "0.50-0.60", ">=0.60"];
  process.stdout.write("--- nearest-neighbour distance (how close each identity's closest twin is) ---\n");
  for (let i = 0; i < nnBuckets.length; i += 1) {
    process.stdout.write(
      `  ${labels[i].padEnd(10)} ${String(nnBuckets[i]).padStart(5)}  ${bar(nnBuckets[i], maxB)}\n`,
    );
  }
  process.stdout.write("  (many identities under ~0.4 => lots of duplicates in the registry)\n\n");

  process.stdout.write("--- duplicate clusters at merge thresholds ---\n");
  const clustersByT = [];
  for (let t = 0; t < thresholds.length; t += 1) {
    const groups = new Map();
    for (let i = 0; i < n; i += 1) {
      const r = ufs[t].find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    const dup = [...groups.values()].filter((c) => c.length >= 2);
    const toMerge = dup.reduce((s, c) => s + c.length - 1, 0);
    clustersByT.push(dup);
    process.stdout.write(
      `  threshold ${thresholds[t].toFixed(2)}: ${dup.length} clusters, ` +
        `${toMerge} identities would merge away (${((toMerge / n) * 100).toFixed(0)}% of registry)\n`,
    );
  }
  process.stdout.write("\n");

  // Largest clusters at the middle threshold, for eyeballing.
  const mid = clustersByT[1] || [];
  mid.sort((a, b) => b.length - a.length);
  process.stdout.write(`--- largest duplicate clusters at threshold ${thresholds[1].toFixed(2)} ---\n`);
  for (let k = 0; k < Math.min(args.top, mid.length); k += 1) {
    const members = mid[k].map((idx) => `${items[idx].shortId}(${items[idx].rec})`);
    process.stdout.write(`  [${mid[k].length}] ${members.join(", ")}\n`);
  }
  process.stdout.write("\n(shortId(N) = identity and its recognition count)\n");
}

main()
  .catch((error) => {
    process.stderr.write(`registry-report failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
