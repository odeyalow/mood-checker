#!/usr/bin/env node
/*
 * Checks every link of the recognition chain and says which one is broken:
 *
 *   RTSP camera -> go2rtc -> worker -> InsightFace service -> DB -> app
 *
 *   node scripts/diagnose.mjs
 *   node scripts/diagnose.mjs --port 3001
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
loadEnvFile(".env.worker", { override: true });
loadEnvFile(".env");

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number.parseInt(process.argv[i + 1], 10) : NaN;
})();
const PORT = Number.isFinite(argPort) ? argPort : Number.parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (m) => console.log(`  [32mOK[0m    ${m}`);
const bad = (m, fix) => {
  console.log(`  [31mFAIL[0m  ${m}`);
  if (fix) console.log(`        -> ${fix}`);
  failures += 1;
};
const warn = (m) => console.log(`  [33mWARN[0m  ${m}`);

async function get(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString("utf-8"), bytes: buf.length, headers: res.headers };
  } catch (error) {
    return { status: 0, text: String(error), bytes: 0, headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\nRecognition pipeline diagnostics (app expected on ${BASE})\n`);

console.log("1. Next.js app");
const app = await get(`${BASE}/api/recognitions?limit=1`);
if (app.status === 0) {
  bad(`nothing answering on ${BASE}`, "start it: npm run dev:all");
} else if (app.status < 500) {
  ok("app is up");
} else {
  bad(`app returned HTTP ${app.status}`);
}

console.log("\n2. go2rtc and the camera");
const go2rtcBase = (process.env.GO2RTC_BASE_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const streamNames = (process.env.WORKER_CAMERA_SOURCES || "")
  .split(",")
  .map((pair) => pair.split("=")[1]?.trim())
  .filter(Boolean);
const stream = streamNames[0] || "cam01_main";

const streams = await get(`${go2rtcBase}/api/streams`, 4000);
if (streams.status === 0) {
  bad(
    `go2rtc not answering on ${go2rtcBase}`,
    "start it: pm2 start ecosystem.config.cjs --only go2rtc (or run the binary directly)",
  );
} else if (streams.status !== 200) {
  bad(`go2rtc /api/streams returned HTTP ${streams.status}`);
} else {
  let parsed = {};
  try {
    parsed = JSON.parse(streams.text);
  } catch {
    /* handled below */
  }
  const names = Object.keys(parsed || {});
  if (!names.length) {
    bad("go2rtc is up but has no streams", "check the streams section of go2rtc.yaml");
  } else if (!names.includes(stream)) {
    bad(
      `go2rtc has [${names.join(", ")}] but the worker asks for "${stream}"`,
      "make WORKER_CAMERA_SOURCES match the stream name in go2rtc.yaml",
    );
  } else {
    ok(`go2rtc up, stream "${stream}" is configured`);
    // Configured is not connected — pulling a real frame is the actual test.
    const width = process.env.GO2RTC_FRAME_WIDTH || 1920;
    const height = process.env.GO2RTC_FRAME_HEIGHT || 1080;
    const quality = process.env.GO2RTC_FRAME_QUALITY || 82;
    const startedAt = Date.now();
    const frame = await get(
      `${go2rtcBase}/api/frame.jpeg?src=${stream}&width=${width}&height=${height}&quality=${quality}`,
      15000,
    );
    const tookMs = Date.now() - startedAt;
    if (frame.status === 200 && frame.bytes > 1000) {
      ok(`camera frame pulled in ${tookMs} ms (${(frame.bytes / 1024).toFixed(0)} KB)`);
      if (tookMs > 2000) {
        warn("that is slow for a snapshot — the worker will inherit this delay every frame");
      }
    } else if (frame.status === 0) {
      bad(
        "no frame within 15 s — go2rtc cannot reach the camera",
        "check the RTSP URL and credentials in go2rtc.yaml, and that the camera is on this network",
      );
    } else {
      bad(`frame request returned HTTP ${frame.status}: ${frame.text.slice(0, 160)}`);
    }
  }
}

console.log("\n3. Worker frame source");
const frameApi = (process.env.WORKER_FRAME_API_BASE || "").trim();
if (!frameApi) {
  ok(`worker pulls straight from go2rtc (${go2rtcBase}/api/frame.jpeg)`);
} else {
  ok(`worker pulls from ${frameApi}`);
  warn("WORKER_FRAME_API_BASE overrides go2rtc — clear it to read the camera directly");
}

console.log("\n4. Worker process");
// Same default the worker itself uses when the variable is unset.
const statusFile =
  (process.env.WORKER_STATUS_FILE || "").trim() || "/tmp/mood-checker-worker-status.json";
if (!fs.existsSync(statusFile)) {
  bad(
    `no status file at ${statusFile} — the worker has probably never run`,
    "pm2 start ecosystem.config.cjs --env production   (locally: npm run dev:all)",
  );
} else {
  const ageMs = Date.now() - fs.statSync(statusFile).mtimeMs;
  if (ageMs > 15000) {
    bad(
      `status file is ${(ageMs / 1000).toFixed(0)} s old — the worker is not running now`,
      "pm2 logs mood-checker-worker --lines 60   (locally: npm run dev:all)",
    );
  } else {
    ok(`worker is alive (status written ${(ageMs / 1000).toFixed(1)} s ago)`);
    try {
      const payload = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      const cam = Object.values(payload?.cameras ?? {})[0];
      if (cam) {
        console.log(
          `        face=${cam.faceInFrame ? 1 : 0} person=${cam.personInFrame ? 1 : 0} ` +
            `maxFaceSide=${cam.maxFaceSide} motion=${Number(cam.motion).toFixed(2)} ` +
            `matched=[${(cam.matchedNames ?? []).join(",")}]`,
        );
      }
    } catch {
      warn("status file is not valid JSON");
    }
  }
}

console.log("\n5. InsightFace service");
const endpoint = (process.env.WORKER_INSIGHTFACE_ENDPOINT || "http://127.0.0.1:8765").replace(/\/+$/, "");
const health = await get(`${endpoint}/health`, 4000);
if (health.status === 0) {
  bad(
    `no answer from ${endpoint}`,
    "the worker starts it — check the worker log for [insightface]; on a first run the " +
      "model download can outlast WORKER_INSIGHTFACE_STARTUP_TIMEOUT_MS",
  );
} else if (health.status !== 200) {
  bad(`/health returned HTTP ${health.status}`);
} else {
  let info = {};
  try {
    info = JSON.parse(health.text);
  } catch {
    /* fall through */
  }
  ok(`service up: model=${info.model} det_size=${info.detSize} det_thresh=${info.detThresh}`);
  if (info.emotionEnabled) {
    ok(
      `emotion model: ${info.emotionModel}` +
        (info.emotionClassBias ? ` bias=${JSON.stringify(info.emotionClassBias)}` : ""),
    );
  } else {
    bad(
      "emotion model NOT loaded — emotions will stay empty",
      "node scripts/download-emotion-model.mjs, then restart the worker",
    );
  }
}

console.log("\n6. Database");
const recognitions = await get(`${BASE}/api/recognitions?limit=3`);
if (recognitions.status === 0) {
  bad("app unreachable, see step 1");
} else {
  let payload = {};
  try {
    payload = JSON.parse(recognitions.text);
  } catch {
    /* handled below */
  }
  if (payload?.error) {
    bad(`/api/recognitions says ${payload.error}`, "npx prisma migrate deploy");
  } else if (Array.isArray(payload?.items)) {
    if (payload.items.length) {
      ok(`${payload.items.length} recent row(s); newest: ${JSON.stringify(payload.items[0])}`);
    } else {
      warn("table reachable but empty — nothing has been recorded yet");
    }
  } else {
    bad(`unexpected response: ${recognitions.text.slice(0, 120)}`);
  }
}

console.log(
  failures
    ? `\n${failures} broken link(s) above — fix the first FAIL and run this again.\n`
    : "\nEvery link answers. If rows still do not appear, watch the worker log while " +
        "someone stands in front of the camera.\n",
);
process.exit(failures ? 1 : 0);
