#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function normalizeFaceShortId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function getStorePath() {
  return process.env.WORKER_BLOCKED_FACE_IDS_FILE || path.join(process.cwd(), "worker", "blocked-face-ids.json");
}

async function readStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
    const out = [];
    for (const value of list) {
      const id = normalizeFaceShortId(value);
      if (id) out.push(id);
    }
    return Array.from(new Set(out)).sort();
  } catch {
    return [];
  }
}

async function writeStore(filePath, ids) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    ids: Array.from(new Set(ids.map(normalizeFaceShortId).filter(Boolean))).sort(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload.ids;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run faces:block -- <SHORT_ID>",
      "  npm run faces:unblock -- <SHORT_ID>",
      "  npm run faces:block:list",
      "  npm run faces:block:clear",
      "",
      "Environment override:",
      "  WORKER_BLOCKED_FACE_IDS_FILE=/path/to/blocked-face-ids.json",
      "",
    ].join("\n"),
  );
}

async function main() {
  const [actionRaw, ...rest] = process.argv.slice(2);
  const action = String(actionRaw || "").trim().toLowerCase();
  const filePath = getStorePath();

  if (!action || action === "help" || action === "--help" || action === "-h") {
    printHelp();
    return;
  }

  const current = await readStore(filePath);
  const currentSet = new Set(current);

  if (action === "list") {
    process.stdout.write(`file=${filePath}\n`);
    process.stdout.write(`count=${current.length}\n`);
    for (const id of current) process.stdout.write(`${id}\n`);
    return;
  }

  if (action === "clear") {
    const next = await writeStore(filePath, []);
    process.stdout.write(`cleared file=${filePath} count=${next.length}\n`);
    return;
  }

  if (action === "block" || action === "unblock") {
    const ids = rest.map(normalizeFaceShortId).filter(Boolean);
    if (!ids.length) {
      process.stderr.write("error: no valid SHORT_ID provided\n");
      process.exit(1);
    }

    if (action === "block") {
      for (const id of ids) currentSet.add(id);
    } else {
      for (const id of ids) currentSet.delete(id);
    }

    const next = await writeStore(filePath, Array.from(currentSet));
    process.stdout.write(`${action} ok file=${filePath} count=${next.length}\n`);
    for (const id of ids) process.stdout.write(`${id}\n`);
    return;
  }

  process.stderr.write(`error: unsupported action "${action}"\n`);
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  process.exit(1);
});
