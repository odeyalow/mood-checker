#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, "prisma", "dev.db");
const brokenMigration = "20260203063848_add_emotion_snapshot";
const args = new Set(process.argv.slice(2));

if (args.has("-h") || args.has("--help")) {
  console.log(
    [
      "Usage: npm run db:repair",
      "",
      "What it does:",
      "1) Creates prisma/dev.db backup (if file exists)",
      "2) Tries to resolve known broken migration both as rolled-back/applied",
      "3) Runs `prisma migrate deploy`",
      "4) Runs `prisma generate`",
    ].join("\n"),
  );
  process.exit(0);
}

function run(command, { allowFail = false } = {}) {
  try {
    console.log(`\n$ ${command}`);
    execSync(command, { stdio: "inherit", cwd: projectRoot });
  } catch (error) {
    if (allowFail) {
      console.warn(`[warn] command failed (ignored): ${command}`);
      return;
    }
    throw error;
  }
}

function backupDb() {
  if (!fs.existsSync(dbPath)) {
    console.log(`[info] database not found, skip backup: ${dbPath}`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.bak.${stamp}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`[ok] backup created: ${backup}`);
}

try {
  console.log("[db-repair] start");
  backupDb();

  // Resolve the historically problematic migration in both directions safely.
  run(`npx prisma migrate resolve --rolled-back "${brokenMigration}"`, { allowFail: true });
  run(`npx prisma migrate resolve --applied "${brokenMigration}"`, { allowFail: true });

  run("npx prisma migrate deploy");
  run("npx prisma generate");

  console.log("\n[db-repair] done");
} catch (error) {
  console.error("\n[db-repair] failed");
  process.exit(1);
}
