#!/usr/bin/env node
/*
 * One command to bring the local stack up: the Next.js dev server and the
 * detection worker, with interleaved, prefixed output and a single Ctrl+C.
 *
 *   node scripts/dev-all.mjs              # web + worker
 *   node scripts/dev-all.mjs --no-worker  # just the web app
 *   node scripts/dev-all.mjs --consumer   # ... also the recognition queue consumer
 *   node scripts/dev-all.mjs --port 3001
 *
 * The worker starts only once the app answers, otherwise it spends its first
 * seconds logging frame and registry errors against a server that is still
 * compiling. The InsightFace Python service is not started here: the worker
 * spawns it itself and reuses one that is already running.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === "win32";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number.parseInt(flagValue("--port") || process.env.PORT || "3000", 10);
const START_WORKER = !hasFlag("--no-worker");
const START_CONSUMER = hasFlag("--consumer");
const READY_TIMEOUT_MS = 120_000;

const COLORS = { web: "[36m", worker: "[35m", consumer: "[33m", sys: "[32m" };
const RESET = "[0m";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function say(tag, line) {
  const color = useColor ? COLORS[tag] || "" : "";
  const reset = useColor && color ? RESET : "";
  process.stdout.write(`${color}[${tag}]${reset} ${line}\n`);
}

/** Pipes a child's stdout/stderr into our own output, one prefixed line at a time. */
function pipeOutput(tag, stream) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) say(tag, line);
  });
  stream.on("end", () => {
    if (buffer.trim()) say(tag, buffer);
  });
}

const children = new Map();
let shuttingDown = false;

function start(tag, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: own process group, so we can signal the whole tree at once.
    detached: !IS_WINDOWS,
  });
  children.set(tag, child);
  pipeOutput(tag, child.stdout);
  pipeOutput(tag, child.stderr);

  child.on("exit", (code, signal) => {
    children.delete(tag);
    if (shuttingDown) return;
    say("sys", `${tag} exited (code=${code ?? "null"} signal=${signal ?? "none"}) — shutting the rest down`);
    void shutdown(code ?? 1);
  });
  child.on("error", (err) => {
    say("sys", `${tag} failed to start: ${String(err)}`);
  });
  return child;
}

/**
 * Kill the child AND anything it spawned. The worker starts the Python
 * InsightFace service, and on Windows a plain kill would leave it running and
 * holding port 8765.
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  say("sys", "stopping…");
  for (const child of children.values()) killTree(child);
  // Give the children a moment to die before we go.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  process.exit(code);
}

async function waitForApp(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/recognitions?limit=1`;
  const startedAt = Date.now();
  let warned = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (shuttingDown) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    if (!warned && Date.now() - startedAt > 20_000) {
      warned = true;
      say("sys", "app is taking a while to compile — still waiting…");
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT_DIR, "server.js"))) {
    say("sys", "server.js not found — run this from the project root");
    process.exit(1);
  }

  say("sys", `starting app on http://localhost:${PORT}`);
  start("web", ["server.js", "--dev"], { PORT: String(PORT) });

  if (!START_WORKER && !START_CONSUMER) {
    say("sys", "worker disabled (--no-worker)");
    return;
  }

  const ready = await waitForApp(PORT, READY_TIMEOUT_MS);
  if (shuttingDown) return;
  if (!ready) {
    say("sys", `app did not answer within ${READY_TIMEOUT_MS / 1000}s — starting the worker anyway`);
  } else {
    say("sys", "app is up");
  }

  if (START_WORKER) {
    say("sys", "starting detection worker (it brings up the InsightFace service itself)");
    start("worker", ["worker/node-detection-worker.mjs"]);
  }
  if (START_CONSUMER) {
    say("sys", "starting recognition consumer");
    start("consumer", ["worker/recognition-consumer.mjs"]);
  }

  say("sys", `ready — open http://localhost:${PORT}   (Ctrl+C stops everything)`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0));
}

main().catch((err) => {
  say("sys", `fatal: ${String(err)}`);
  void shutdown(1);
});
