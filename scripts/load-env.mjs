/*
 * Loads .env for plain `node scripts/*.mjs` runs.
 *
 * The Prisma CLI reads .env by itself, so `prisma migrate deploy` works without
 * this — but a bare Node script does not, and PrismaClient then fails with
 * "Environment variable not found: DATABASE_URL". That only shows up outside the
 * shell where the variable happens to be exported, which is why it surfaced on
 * the server and not in local runs.
 *
 * Import it first, before anything that constructs a PrismaClient:
 *   import "./load-env.mjs";
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnvFile(file, { override = false } = {}) {
  const abs = path.join(ROOT_DIR, file);
  if (!fs.existsSync(abs)) return;
  for (const line of fs.readFileSync(abs, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] == null) process.env[key] = value;
  }
}

// Real environment wins over both files; .env.worker wins over .env.
loadEnvFile(".env.worker");
loadEnvFile(".env");

export { loadEnvFile };
