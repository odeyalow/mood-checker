#!/usr/bin/env node
/*
 * The MJPEG reader must survive a stream that goes silent WITHOUT closing —
 * what go2rtc leaves behind when its on-demand transcoder dies. Before the
 * watchdog the reader waited on that socket forever while every pass fell back
 * to a one-shot frame from the H.265 main stream, measured at 3.9 s each: a
 * pipeline that looks alive in every log but runs twenty times too slow.
 *
 *   node scripts/test-mjpeg-reader.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT_DIR, "worker", "node-detection-worker.mjs"), "utf8");
const start = src.indexOf("function createMjpegReader(");
const end = src.indexOf("async function fetchFrame(");
if (start < 0 || end < 0) throw new Error("cannot locate createMjpegReader in the worker");
const createMjpegReader = new Function(
  "sleep",
  `${src.slice(start, end)}; return createMjpegReader;`,
)(sleep);

function frame(n, size = 4096) {
  const b = Buffer.alloc(size, 0x41 + (n % 26));
  b[0] = 0xff;
  b[1] = 0xd8;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}
const HEADER = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// 1. A stream that stops sending but never closes.
console.log("\nsilent stream — the reader must reconnect\n");
{
  let connections = 0;
  const server = http.createServer(async (req, res) => {
    const id = ++connections;
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    for (let i = 0; i < 3; i += 1) {
      res.write(HEADER);
      res.write(frame(id * 10 + i));
      res.write(Buffer.from("\r\n"));
      await sleep(60);
    }
    // Silence, socket deliberately left open.
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const logs = [];
  const reader = createMjpegReader({
    url: `http://127.0.0.1:${port}/stream`,
    staleMs: 1000,
    silenceMs: 1200,
    log: (m) => logs.push(m),
  });
  await sleep(5000);
  const stats = reader.stats();
  reader.stop();
  server.close();

  check("reconnected through the silence", connections >= 2, `${connections} connections`);
  check("reported the silence", logs.some((m) => m.includes("no data for")));
  check("kept reading frames afterwards", stats.frames >= 6, `${stats.frames} frames`);
}

// 2. A healthy stream must not trip the watchdog, and frames split anywhere —
// including between the two bytes of an end-of-image marker — must survive whole.
console.log("\nhealthy stream — frames must arrive intact and uninterrupted\n");
{
  const frames = [frame(0, 600_000), frame(1, 5_000), frame(2, 300_003), frame(3, 64)];
  const stream = Buffer.concat(frames.flatMap((f) => [HEADER, f, Buffer.from("\r\n")]));
  const cuts = new Set();
  for (let p = 16_384; p < stream.length; p += 16_384) cuts.add(p);
  cuts.add(HEADER.length + 600_000 - 1); // between 0xFF and 0xD9 of the first EOI
  let pos = 0;
  for (const f of frames) {
    pos += HEADER.length;
    cuts.add(pos + f.length);
    pos += f.length + 2;
  }
  const cutList = [...cuts].sort((a, b) => a - b);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    (async () => {
      let prev = 0;
      for (const c of cutList) {
        res.write(stream.subarray(prev, c));
        prev = c;
        await sleep(25);
      }
      res.write(stream.subarray(prev));
    })();
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const logs = [];
  const reader = createMjpegReader({
    url: `http://127.0.0.1:${port}/stream`,
    staleMs: 0,
    silenceMs: 4000,
    log: (m) => logs.push(m),
  });

  const seen = new Map();
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const f = reader.take();
    if (f) seen.set(`${f.length}:${f[2]}`, f);
    await sleep(1);
  }
  const stats = reader.stats();
  reader.stop();
  server.close();

  const sizes = [...seen.values()].map((f) => f.length).sort((a, b) => a - b);
  const allWhole = [...seen.values()].every(
    (f) => f[0] === 0xff && f[1] === 0xd8 && f[f.length - 2] === 0xff && f[f.length - 1] === 0xd9,
  );
  check("every frame handed out is a complete JPEG", allWhole, sizes.join(", "));
  check("the frame split across its EOI marker survived", sizes.includes(600_000));
  check("counted every frame sent", stats.frames === frames.length, `${stats.frames}`);
  check("watchdog stayed quiet", !logs.some((m) => m.includes("no data for")));
}

console.log(failures ? `\n${failures} failing check(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
