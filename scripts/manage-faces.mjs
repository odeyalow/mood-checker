#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/manage-faces.mjs clear",
      "  node scripts/manage-faces.mjs delete <SHORT_ID>",
      "",
    ].join("\n"),
  );
}

function sanitizeShortId(shortId) {
  return String(shortId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

async function removeFaceSnapshotDir(shortId) {
  const safeId = sanitizeShortId(shortId);
  if (!safeId) return;
  const dir = path.join(process.cwd(), "public", "_faces", safeId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function clearAllFaces() {
  const identities = await prisma.faceIdentity.findMany({
    select: { id: true, shortId: true },
  });
  const ids = identities.map((item) => item.id);
  const shortIds = identities.map((item) => item.shortId);

  let recognitionsDeleted = 0;
  if (ids.length || shortIds.length) {
    const deletedRecognitions = await prisma.recognition.deleteMany({
      where: {
        OR: [{ faceIdentityId: { in: ids } }, { name: { in: shortIds } }],
      },
    });
    recognitionsDeleted = deletedRecognitions.count;
  }

  const deletedFaces = await prisma.faceIdentity.deleteMany({});

  await fs.rm(path.join(process.cwd(), "public", "_faces"), {
    recursive: true,
    force: true,
  });
  await fs.mkdir(path.join(process.cwd(), "public", "_faces"), { recursive: true });

  process.stdout.write(
    `Cleared faces: ${deletedFaces.count}, recognitions: ${recognitionsDeleted}\n`,
  );
}

async function deleteFaceByShortId(shortIdRaw) {
  const shortId = String(shortIdRaw ?? "").trim();
  if (!shortId) {
    process.stderr.write("Error: SHORT_ID is required\n");
    usage();
    process.exitCode = 1;
    return;
  }

  const face = await prisma.faceIdentity.findUnique({
    where: { shortId },
    select: { id: true, shortId: true },
  });

  if (!face) {
    process.stderr.write(`Face not found: ${shortId}\n`);
    process.exitCode = 1;
    return;
  }

  const deletedRecognitions = await prisma.recognition.deleteMany({
    where: {
      OR: [{ faceIdentityId: face.id }, { name: face.shortId }],
    },
  });

  await prisma.faceIdentity.delete({ where: { id: face.id } });
  await removeFaceSnapshotDir(face.shortId);

  process.stdout.write(
    `Deleted face ${face.shortId}, recognitions: ${deletedRecognitions.count}\n`,
  );
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (!cmd) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (cmd === "clear") {
    await clearAllFaces();
    return;
  }

  if (cmd === "delete") {
    await deleteFaceByShortId(arg);
    return;
  }

  usage();
  process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`manage-faces failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

