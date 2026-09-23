#!/usr/bin/env node
/*
 * Shows an identity's template vectors and how far each sits from the others,
 * and can drop the ones that do not belong.
 *
 * A template holds several vectors so one identity can cover several angles of
 * the same face. Two things can put a stranger's vector in there: a merge that
 * folded the wrong identity in, and learning from a match that was too distant.
 * Once inside, that vector matches its owner forever — the person it came from
 * is then recognised as this identity.
 *
 * Genuine poses of one face sit within about 0.50 of each other on this camera;
 * a stranger's vector stands out well beyond that.
 *
 *   node scripts/prune-template.mjs DFT5PE            # inspect only
 *   node scripts/prune-template.mjs DFT5PE --apply    # drop the outliers
 *   node scripts/prune-template.mjs DFT5PE --max 0.55 --apply
 */
import "./load-env.mjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const shortId = (args.find((a) => !a.startsWith("--")) || "").trim().toUpperCase();
const apply = args.includes("--apply");
// Drop exactly the vectors flagged as risky rather than everything past --max:
// a far pose with a healthy margin is worth keeping, a near one without is not.
const riskyOnly = args.includes("--risky");
const maxArg = Number(args[args.indexOf("--max") + 1]);
const MAX_SPREAD = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : 0.6;

if (!shortId) {
  process.stderr.write(
    "usage: node scripts/prune-template.mjs <SHORT_ID> [--risky] [--max 0.6] [--apply]\n",
  );
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

async function main() {
  const face = await prisma.faceIdentity.findUnique({
    where: { shortId },
    select: { id: true, shortId: true, descriptor: true, descriptors: true },
  });
  if (!face) {
    process.stdout.write(`no identity with shortId ${shortId}\n`);
    return;
  }

  const primary = toUnit(face.descriptor);
  const stored = Array.isArray(face.descriptors) ? face.descriptors : [];
  const vectors = stored.map((raw) => ({ raw, unit: toUnit(raw) })).filter((v) => v.unit);

  if (vectors.length < 2) {
    process.stdout.write(
      `${shortId}: template holds ${vectors.length} vector(s) — nothing to prune.\n`,
    );
    return;
  }

  process.stdout.write(`\n===== ${shortId}: ${vectors.length} template vectors =====\n\n`);
  process.stdout.write("        " + vectors.map((_, i) => `   v${i}`).join("") + "   to primary\n");
  const farthest = [];
  for (let i = 0; i < vectors.length; i += 1) {
    let row = `  v${String(i).padEnd(5)}`;
    let worst = 0;
    for (let j = 0; j < vectors.length; j += 1) {
      if (i === j) {
        row += "      -";
        continue;
      }
      const d = cosine(vectors[i].unit, vectors[j].unit);
      worst = Math.max(worst, d);
      row += d.toFixed(2).padStart(7);
    }
    const toPrimary = primary ? cosine(vectors[i].unit, primary) : Number.NaN;
    row += `${Number.isFinite(toPrimary) ? toPrimary.toFixed(2).padStart(13) : "            -"}`;
    process.stdout.write(`${row}\n`);
    farthest.push({ index: i, worst, toPrimary });
  }

  process.stdout.write(
    "\n  Poses of one face sit within ~0.50 of each other here; a vector that is\n" +
      "  far from every other one came from somebody else.\n\n",
  );

  // The decisive test. Distance alone cannot separate "an unusual angle of this
  // person" from "a stranger a merge left behind" — both land in 0.55-0.75. But
  // a vector that came from someone else is, by definition, closer to that
  // someone else than to the face it is filed under. If the nearest OTHER
  // identity beats the primary vector, it does not belong here.
  const others = await prisma.faceIdentity.findMany({
    where: { id: { not: face.id } },
    select: { shortId: true, descriptor: true, descriptors: true },
  });
  const otherVectors = [];
  for (const other of others) {
    const list = Array.isArray(other.descriptors) && other.descriptors.length
      ? other.descriptors
      : [other.descriptor];
    for (const raw of list) {
      const unit = toUnit(raw);
      if (unit) otherVectors.push({ shortId: other.shortId, unit });
    }
  }

  // Vectors that reach into somebody else's space: either outright theirs, or
  // so close to them that keeping them invites a look-alike match.
  const riskyIndexes = new Set();
  if (otherVectors.length) {
    process.stdout.write("--- who each vector is closest to ---\n");
    for (let i = 0; i < vectors.length; i += 1) {
      let best = null;
      for (const candidate of otherVectors) {
        const d = cosine(vectors[i].unit, candidate.unit);
        if (!best || d < best.distance) best = { shortId: candidate.shortId, distance: d };
      }
      const toPrimary = primary ? cosine(vectors[i].unit, primary) : Number.POSITIVE_INFINITY;
      const foreign = best && best.distance < toPrimary;
      // How much closer this vector is to its own face than to the nearest
      // other person. Distance to the primary alone does not decide: a far
      // but distinctive pose is useful, while one that is equally close to
      // somebody else is a loaded gun, because matching takes the minimum
      // over template members.
      const margin = best ? best.distance - toPrimary : Number.POSITIVE_INFINITY;
      const verdict = foreign
        ? "   <-- belongs to them, not here"
        : margin < 0.1
        ? "   <-- DANGER: as close to them as to itself"
        : margin < 0.25
        ? "   <-- thin margin"
        : "";
      if (foreign || margin < 0.1) riskyIndexes.add(i);
      process.stdout.write(
        `  v${i}  own ${Number.isFinite(toPrimary) ? toPrimary.toFixed(3) : "-"}` +
          `   nearest other: ${best.shortId} ${best.distance.toFixed(3)}` +
          `   margin ${Number.isFinite(margin) ? margin.toFixed(3) : "inf"}${verdict}\n`,
      );
    }
    process.stdout.write(
      "\n  margin = how much closer this vector is to its own face than to the\n" +
        "  nearest other person. Matching takes the minimum over template members,\n" +
        "  so a thin margin is what lets a look-alike in: that vector reaches into\n" +
        "  someone else's space. Above ~0.25 it is a useful extra angle even when\n" +
        "  it sits far from the primary.\n\n",
    );
    if (riskyIndexes.size) {
      process.stdout.write(
        `  ${riskyIndexes.size} vector(s) flagged: v${[...riskyIndexes].join(", v")}\n` +
          "  Remove exactly those with:  --risky --apply\n\n",
      );
    }
  }

  // Keep the largest group of vectors that are all within MAX_SPREAD of each
  // other, measured from the primary vector outward — that is the real face.
  const anchor = primary ?? vectors[0].unit;
  const keep = [];
  const drop = [];
  for (let i = 0; i < vectors.length; i += 1) {
    const d = cosine(vectors[i].unit, anchor);
    const doomed = riskyOnly ? riskyIndexes.has(i) : d > MAX_SPREAD;
    (doomed ? drop : keep).push({ index: i, distance: d });
  }

  process.stdout.write(
    riskyOnly
      ? "--- dropping only the flagged vectors ---\n"
      : `--- at --max ${MAX_SPREAD} ---\n`,
  );
  for (const item of keep) {
    process.stdout.write(`  keep  v${item.index}  ${item.distance.toFixed(3)} from primary\n`);
  }
  for (const item of drop) {
    process.stdout.write(`  DROP  v${item.index}  ${item.distance.toFixed(3)} from primary\n`);
  }
  if (!drop.length) {
    process.stdout.write("\n  Nothing to drop: every vector is consistent with the primary.\n\n");
    return;
  }
  if (!keep.length) {
    process.stdout.write(
      "\n  Every vector is far from the primary — the identity itself is suspect.\n" +
        "  Block it from the Faces page rather than pruning.\n\n",
    );
    return;
  }

  if (!apply) {
    process.stdout.write(
      `\n  Nothing written. Re-run with --apply to keep ${keep.length} and drop ${drop.length}.\n\n`,
    );
    return;
  }

  const next = keep.map((item) => vectors[item.index].raw);
  await prisma.faceIdentity.update({
    where: { id: face.id },
    data: { descriptors: next },
  });
  process.stdout.write(
    `\n  Written: template now holds ${next.length} vector(s). The worker reloads the\n` +
      `  registry within WORKER_FACE_REGISTRY_REFRESH_MS (20 s by default).\n\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`prune-template failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
