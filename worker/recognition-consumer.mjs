#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(message) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  process.stdout.write(`[recognition-consumer ${ts}] ${message}\n`);
}

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const v = line.trim();
    if (!v || v.startsWith("#")) continue;
    const eq = v.indexOf("=");
    if (eq <= 0) continue;
    const key = v.slice(0, eq).trim();
    const val = stripQuotes(v.slice(eq + 1));
    if (!key) continue;
    if (override || process.env[key] == null) process.env[key] = val;
  }
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`db_http_${res.status}${body ? ` body=${body.slice(0, 180)}` : ""}`);
    }
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  } finally {
    clearTimeout(t);
  }
}

async function readCursor(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const offset = Number(parsed?.offset ?? 0);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(filePath, offset) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ offset, updatedAt: new Date().toISOString() }), "utf-8");
  await fsp.rename(tmp, filePath);
}

async function appendRetry(filePath, item) {
  const line = `${JSON.stringify(item)}\n`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, line, "utf-8");
}

async function main() {
  loadEnvFile(path.join(rootDir, ".env.worker"), { override: true });
  loadEnvFile(path.join(rootDir, ".env"));

  const dbEndpoint = (process.env.WORKER_DB_ENDPOINT || "http://127.0.0.1:3000/api/recognitions").trim();
  const queueFile = String(
    process.env.WORKER_DB_QUEUE_FILE || path.join(rootDir, "worker", "recognition-queue.jsonl"),
  ).trim();
  const cursorFile = String(process.env.WORKER_DB_QUEUE_CURSOR_FILE || `${queueFile}.cursor`).trim();

  const pollMs = Math.max(80, envInt("WORKER_DB_QUEUE_CONSUMER_POLL_MS", 220));
  const batchSize = Math.max(1, envInt("WORKER_DB_QUEUE_BATCH_SIZE", 6));
  const requestTimeoutMs = Math.max(500, envInt("WORKER_DB_TIMEOUT_MS", 1500));
  const maxAttempts = Math.max(1, envInt("WORKER_DB_QUEUE_MAX_ATTEMPTS", 4));
  const retryBaseMs = Math.max(200, envInt("WORKER_DB_QUEUE_RETRY_BASE_MS", 1000));
  const compactAtBytes = Math.max(1024 * 256, envInt("WORKER_DB_QUEUE_COMPACT_AT_BYTES", 1024 * 1024));

  let offset = await readCursor(cursorFile);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  log(`started endpoint=${dbEndpoint} queue=${queueFile}`);

  while (!stopping) {
    try {
      const stat = await fsp.stat(queueFile).catch(() => null);
      if (!stat || !stat.isFile() || stat.size <= 0) {
        await sleep(pollMs);
        continue;
      }

      if (offset > stat.size) {
        offset = 0;
        await writeCursor(cursorFile, offset);
      }
      if (offset === stat.size) {
        await sleep(pollMs);
        continue;
      }

      const handle = await fsp.open(queueFile, "r");
      const chunkSize = Number(stat.size - offset);
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset);
      await handle.close();
      if (bytesRead <= 0) {
        await sleep(pollMs);
        continue;
      }

      const text = buffer.subarray(0, bytesRead).toString("utf-8");
      offset += bytesRead;
      await writeCursor(cursorFile, offset);

      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let processed = 0;
      let sent = 0;
      let skipped = 0;
      let retried = 0;
      const now = Date.now();

      for (const line of lines) {
        processed += 1;

        let item;
        try {
          item = JSON.parse(line);
        } catch {
          continue;
        }

        const payload = item?.payload && typeof item.payload === "object" ? item.payload : item;
        const attempts = Number(item?.attempts ?? 0);
        const nextAttemptAt = Number(item?.nextAttemptAt ?? 0);
        if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now) {
          await appendRetry(queueFile, {
            payload,
            attempts,
            nextAttemptAt,
            enqueuedAt: item?.enqueuedAt || new Date().toISOString(),
          });
          retried += 1;
          continue;
        }

        try {
          const result = await postJsonWithTimeout(dbEndpoint, payload, requestTimeoutMs);
          const skippedReason = String(result?.skipped || "").trim();
          if (skippedReason) {
            skipped += 1;
          } else {
            sent += 1;
          }
        } catch (err) {
          const nextAttempts = attempts + 1;
          if (nextAttempts < maxAttempts) {
            const backoff = retryBaseMs * Math.pow(2, Math.max(0, nextAttempts - 1));
            await appendRetry(queueFile, {
              payload,
              attempts: nextAttempts,
              nextAttemptAt: Date.now() + backoff,
              enqueuedAt: item?.enqueuedAt || new Date().toISOString(),
            });
            retried += 1;
          } else {
            log(`drop after attempts=${nextAttempts} err=${String(err)}`);
          }
        }
      }

      if (processed > 0) {
        log(
          `batch processed=${processed} sent=${sent} skipped=${skipped} retried=${retried} ` +
            `batch_limit=${batchSize}`,
        );
      }

      const after = await fsp.stat(queueFile).catch(() => null);
      if (after && offset >= after.size && after.size >= compactAtBytes) {
        await fsp.writeFile(queueFile, "", "utf-8");
        offset = 0;
        await writeCursor(cursorFile, offset);
        log(`queue compacted bytes=${after.size}`);
      }
    } catch (err) {
      log(`loop error: ${String(err)}`);
      await sleep(Math.max(300, pollMs));
    }

    await sleep(pollMs);
  }

  log("stop signal received");
}

main().catch((err) => {
  process.stderr.write(`[recognition-consumer] fatal: ${String(err)}\n`);
  process.exit(1);
});
