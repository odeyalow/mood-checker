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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fmt = (value) => (Number.isFinite(value) ? Number(value).toFixed(3) : "-");
const ts = (date, len = 19) => (date instanceof Date ? date.toISOString().slice(0, len) : "-");

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

/*
 * Where a row can go missing between pages. The Faces list groups rows by
 * `name`, the detail page counts rows by name OR faceIdentityId, and the
 * pictures on the detail page also include crops the worker archives on disk
 * without any row. When the three disagree, this is where it shows.
 */
async function printConsistency(identities) {
  const shortIdByPk = new Map(identities.map((it) => [it.id, it.shortId]));
  const knownShortIds = new Set(identities.map((it) => it.shortId));

  // Merges the identify route performed in its post-check: a freshly created
  // identity that turned out to be an existing person is folded into it.
  let merges = [];
  try {
    merges = await prisma.faceDedupLog.findMany({ orderBy: { createdAt: "desc" }, take: 15 });
  } catch {
    merges = [];
  }
  process.stdout.write("--- last merges (identify post-check, newest first) ---\n");
  if (!merges.length) process.stdout.write("  none\n");
  for (const m of merges) {
    process.stdout.write(
      `  ${ts(m.createdAt)}  ${m.action}  ${m.sourceShortId ?? "?"} -> ${m.targetShortId ?? "?"}  ` +
        `dist=${fmt(m.distance)} th=${fmt(m.threshold)}\n`,
    );
  }
  process.stdout.write("\n");

  const recs = await prisma.recognition.findMany({
    orderBy: { detectedAt: "desc" },
    take: 3000,
    select: {
      id: true,
      name: true,
      faceIdentityId: true,
      detectedAt: true,
      mood: true,
      cameraId: true,
      snapshotUrl: true,
    },
  });

  const mismatched = recs.filter(
    (r) => r.faceIdentityId && shortIdByPk.has(r.faceIdentityId) && shortIdByPk.get(r.faceIdentityId) !== r.name,
  );
  const unlinked = recs.filter((r) => !r.faceIdentityId);
  const orphanNames = new Map();
  for (const r of recs) {
    if (!knownShortIds.has(r.name)) orphanNames.set(r.name, (orphanNames.get(r.name) ?? 0) + 1);
  }
  process.stdout.write("--- recognition rows vs identities ---\n");
  process.stdout.write(`  rows checked:                         ${recs.length}\n`);
  process.stdout.write(`  name differs from linked identity:    ${mismatched.length}\n`);
  for (const r of mismatched.slice(0, 10)) {
    process.stdout.write(`     ${ts(r.detectedAt)} name=${r.name} identity=${shortIdByPk.get(r.faceIdentityId)}\n`);
  }
  process.stdout.write(`  no identity link (faceIdentityId null): ${unlinked.length}\n`);
  process.stdout.write(`  names without an identity row:        ${orphanNames.size}\n`);
  for (const [name, count] of orphanNames) process.stdout.write(`     ${name} (${count} rows)\n`);
  process.stdout.write("\n");

  const byName = new Map();
  const byLink = new Map();
  for (const r of recs) {
    byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
    if (r.faceIdentityId) byLink.set(r.faceIdentityId, (byLink.get(r.faceIdentityId) ?? 0) + 1);
  }
  process.stdout.write("--- per identity: rows by name / rows by link / pictures on disk ---\n");
  process.stdout.write("  (by_name is what the Faces card shows; pictures include archived crops without a row)\n");
  for (const it of identities) {
    const dir = path.join(ROOT_DIR, "public", "_faces", it.shortId);
    let pictures = 0;
    try {
      pictures = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).length;
    } catch {
      pictures = 0;
    }
    const last = recs.find((r) => r.name === it.shortId || r.faceIdentityId === it.id);
    process.stdout.write(
      `  ${String(it.shortId).padEnd(8)} by_name=${String(byName.get(it.shortId) ?? 0).padStart(3)} ` +
        `by_link=${String(byLink.get(it.id) ?? 0).padStart(3)} pictures=${String(pictures).padStart(3)} ` +
        `created=${ts(it.createdAt, 16)} last_row=${last ? ts(last.detectedAt, 16) : "-"}\n`,
    );
  }
  process.stdout.write("\n");

  process.stdout.write("--- last 12 rows ---\n");
  for (const r of recs.slice(0, 12)) {
    process.stdout.write(
      `  ${ts(r.detectedAt)} ${String(r.name).padEnd(8)} ${String(r.mood).padEnd(14)} ` +
        `${r.cameraId ?? "-"} ${String(r.snapshotUrl ?? "").slice(0, 52)}\n`,
    );
  }
  process.stdout.write("\n");
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

  await printConsistency(identities);

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

  // A histogram that stops at ">=0.60" hides the difference between 0.61 — a
  // degraded but still usable embedding — and 0.95, where no identity
  // information survives at all. That distinction decides whether changing
  // WORKER_MATCH_THRESHOLD can help or whether the face simply needs more
  // pixels. With a handful of identities the exact numbers fit on screen.
  if (n >= 2 && n <= 12) {
    process.stdout.write("--- exact pairwise distances ---\n");
    process.stdout.write(
      "        " + items.map((it) => String(it.shortId).padStart(8)).join("") + "\n",
    );
    for (let i = 0; i < n; i += 1) {
      let row = String(items[i].shortId).padEnd(8);
      for (let j = 0; j < n; j += 1) {
        row += i === j ? "       -" : cosineDistance(items[i].vec, items[j].vec).toFixed(2).padStart(8);
      }
      process.stdout.write(row + "\n");
    }
    process.stdout.write("\n");
    process.stdout.write("  same person, good crops : 0.20-0.50\n");
    process.stdout.write("  same person, poor crops : 0.50-0.70  (a higher threshold can help)\n");
    process.stdout.write("  different people        : 0.80-1.00\n");
    process.stdout.write("  Above ~0.75 between crops of the SAME face means too little detail\n");
    process.stdout.write("  survived the capture — no threshold fixes that.\n\n");
  }

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
