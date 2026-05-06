#!/usr/bin/env node

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function isUnknownIdentity(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === "unknown" ||
    normalized === "unrecognized" ||
    normalized === "not_recognized" ||
    normalized === "undefined" ||
    normalized === "null" ||
    normalized === "none" ||
    normalized === "n/a"
  );
}

async function main() {
  const names = await prisma.recognition.findMany({
    distinct: ["name"],
    select: { name: true },
  });

  let identitiesCreated = 0;
  let recognitionsRelinked = 0;

  for (const row of names) {
    const shortId = String(row.name || "").trim();
    if (!shortId || isUnknownIdentity(shortId)) continue;

    const identity = await prisma.faceIdentity.upsert({
      where: { shortId },
      create: { shortId, descriptor: [] },
      update: {},
      select: { id: true, createdAt: true, updatedAt: true },
    });

    if (identity.createdAt.getTime() === identity.updatedAt.getTime()) {
      identitiesCreated += 1;
    }

    const relinked = await prisma.recognition.updateMany({
      where: {
        name: shortId,
        OR: [{ faceIdentityId: null }, { faceIdentityId: "" }],
      },
      data: { faceIdentityId: identity.id },
    });
    recognitionsRelinked += relinked.count;
  }

  process.stdout.write(
    `Rebuilt face identities. created=${identitiesCreated} relinked=${recognitionsRelinked}\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`rebuild-face-identities failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });