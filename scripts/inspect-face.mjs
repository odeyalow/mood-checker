#!/usr/bin/env node
/*
 * Everything known about one identity, for deciding whether it is a real person
 * or junk that should be blocked.
 *
 * Answers the questions a look at the Faces page cannot: how close it sits to
 * every other identity (a junk row built from ears and the backs of heads tends
 * to sit suspiciously close to several people at once), how many vectors its
 * template holds, what quality its reference frame had, and how its sightings
 * are spread over time.
 *
 *   node scripts/inspect-face.mjs RDLZ5S
 *   node scripts/inspect-face.mjs RDLZ5S --near 15
 */
import "./load-env.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const shortId = (args.find((a) => !a.startsWith("--")) || "").trim().toUpperCase();
const nearCount = Math.max(1, Number(args[args.indexOf("--near") + 1]) || 10);

if (!shortId) {
  process.stderr.write("usage: node scripts/inspect-face.mjs <SHORT_ID> [--near N]\n");
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
const ts = (d) => (d instanceof Date ? d.toISOString().slice(0, 16).replace("T", " ") : "-");

async function main() {
  // primaryQuality arrived with a later migration; without it this still runs.
  let face = null;
  try {
    face = await prisma.faceIdentity.findUnique({
      where: { shortId },
      select: {
        id: true,
        shortId: true,
        descriptor: true,
        descriptors: true,
        primaryQuality: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch {
    face = await prisma.faceIdentity.findUnique({
      where: { shortId },
      select: {
        id: true,
        shortId: true,
        descriptor: true,
        descriptors: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
  if (!face) {
    process.stdout.write(`no identity with shortId ${shortId}\n`);
    return;
  }

  let template = [];
  try {
    template = Array.isArray(face.descriptors) ? face.descriptors : [];
  } catch {
    template = [];
  }

  process.stdout.write(`\n===== ${shortId} =====\n`);
  process.stdout.write(`created:          ${ts(face.createdAt)}\n`);
  process.stdout.write(`last updated:     ${ts(face.updatedAt)}\n`);
  process.stdout.write(
    `reference quality: ${
      face.primaryQuality == null
        ? "not recorded (enrolled before quality tracking)"
        : Number(face.primaryQuality).toFixed(3)
    }\n`,
  );
  process.stdout.write(`template vectors:  ${template.length || 1}\n`);

  const recognitions = await prisma.recognition.findMany({
    where: { OR: [{ faceIdentityId: face.id }, { name: shortId }] },
    orderBy: { detectedAt: "asc" },
    select: { detectedAt: true, mood: true, distance: true, emotionConfidence: true },
  });
  process.stdout.write(`recognitions:      ${recognitions.length}\n`);

  const dir = path.join(ROOT_DIR, "public", "_faces", shortId);
  let pictures = [];
  try {
    pictures = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
  } catch {
    pictures = [];
  }
  process.stdout.write(`pictures on disk:  ${pictures.length}  (${dir})\n\n`);

  if (recognitions.length) {
    const nums = (key) => recognitions.map((r) => Number(r[key])).filter((n) => Number.isFinite(n) && n > 0);
    const stat = (key) => {
      const v = nums(key).sort((a, b) => a - b);
      if (!v.length) return "n/a";
      return `min ${v[0].toFixed(2)}  median ${v[Math.floor(v.length / 2)].toFixed(2)}  max ${v.at(-1).toFixed(2)}`;
    };
    process.stdout.write("--- what its sightings looked like ---\n");
    process.stdout.write(`  match distance:     ${stat("distance")}
`);
    process.stdout.write(`  emotion confidence: ${stat("emotionConfidence")}
`);
    const moods = new Map();
    for (const r of recognitions) moods.set(r.mood, (moods.get(r.mood) ?? 0) + 1);
    process.stdout.write(
      `  moods:          ${[...moods.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m} x${c}`).join(", ")}\n`,
    );
    process.stdout.write(
      `  first / last:   ${ts(recognitions[0].detectedAt)}  ..  ${ts(recognitions.at(-1).detectedAt)}\n\n`,
    );
  }

  // Distance to every other identity. A row built from non-faces tends to sit
  // unusually close to several unrelated people, because the vectors it holds
  // carry no identity information to separate them.
  const mine = toUnit(face.descriptor);
  if (!mine) {
    process.stdout.write("no usable vector stored for this identity\n");
    return;
  }
  const others = await prisma.faceIdentity.findMany({
    where: { id: { not: face.id } },
    select: { shortId: true, descriptor: true, _count: { select: { recognitions: true } } },
  });
  const ranked = [];
  for (const other of others) {
    const vec = toUnit(other.descriptor);
    if (!vec) continue;
    ranked.push({ shortId: other.shortId, distance: cosine(mine, vec), rec: other._count.recognitions });
  }
  ranked.sort((a, b) => a.distance - b.distance);

  process.stdout.write(`--- nearest identities (of ${ranked.length}) ---\n`);
  for (const item of ranked.slice(0, nearCount)) {
    const flag =
      item.distance < 0.6 ? "  <-- would match" : item.distance < 0.75 ? "  <-- close" : "";
    process.stdout.write(
      `  ${item.shortId.padEnd(8)} ${item.distance.toFixed(3)}  (${item.rec} recognitions)${flag}\n`,
    );
  }
  const close = ranked.filter((r) => r.distance < 0.75).length;
  process.stdout.write(
    `\n  ${close} identit${close === 1 ? "y sits" : "ies sit"} closer than 0.75.\n`,
  );
  process.stdout.write(
    "  Different people normally sit at 0.80-1.05 on this camera. An identity close\n" +
      "  to several unrelated people at once is usually built from non-faces, and\n" +
      "  will keep absorbing strangers — block it rather than delete it, so its\n" +
      "  vector stays known and cannot be created again.\n\n",
  );
}

main()
  .catch((error) => {
    process.stderr.write(`inspect-face failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
