#!/usr/bin/env node
/*
 * Downloads the HSEmotion ONNX emotion model used by worker/insightface-service.py.
 *
 * The model is ~16 MB, so it is fetched on setup instead of being committed.
 * Source: https://github.com/HSE-asavchenko/face-emotion-recognition (Apache-2.0)
 *
 *   node scripts/download-emotion-model.mjs                  # default model
 *   node scripts/download-emotion-model.mjs enet_b2_8        # larger / slower
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODELS_DIR = path.join(ROOT_DIR, "worker", "models");
const BASE_URL =
  "https://github.com/HSE-asavchenko/face-emotion-recognition/raw/main/models/affectnet_emotions/onnx";

// Known models in that directory, with their published sizes in bytes.
const MODELS = {
  enet_b0_8_best_afew: 16039595,
  enet_b0_8_best_vgaf: 16039595,
  enet_b2_8: 30779724,
};

const DEFAULT_MODEL = "enet_b0_8_best_afew";

async function main() {
  const name = (process.argv[2] || DEFAULT_MODEL).replace(/\.onnx$/i, "");
  const expectedSize = MODELS[name];
  if (!expectedSize) {
    console.error(`Unknown model "${name}". Known: ${Object.keys(MODELS).join(", ")}`);
    return 1;
  }

  const target = path.join(MODELS_DIR, `${name}.onnx`);
  if (fs.existsSync(target)) {
    const { size } = await fsp.stat(target);
    if (size === expectedSize) {
      console.log(`Already present: ${target} (${size} bytes)`);
      return 0;
    }
    console.log(`Re-downloading ${target}: size ${size} != expected ${expectedSize}`);
  }

  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const url = `${BASE_URL}/${name}.onnx`;
  console.log(`Downloading ${url}`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    console.error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    return 1;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== expectedSize) {
    console.error(
      `Refusing to write: got ${buffer.length} bytes, expected ${expectedSize}. ` +
        "The upstream file may have changed — verify before updating this script.",
    );
    return 1;
  }

  // Write to a temp file first so an interrupted run cannot leave a half model
  // that the service would then try to load.
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
  console.log(`Saved ${target} (${buffer.length} bytes)`);
  console.log("Restart the worker to pick it up: npm run pm2:restart:worker");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Download failed:", error);
    process.exit(1);
  });
