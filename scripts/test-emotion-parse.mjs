#!/usr/bin/env node
/*
 * What the worker reports for a given set of model probabilities.
 *
 * The post-processing below WORKER_EMOTION_TRUST_MODEL was written for
 * face-api, whose expression outputs needed correcting. HSEmotion returns a
 * calibrated softmax, and the same corrections then bias it: neutral is
 * discounted and a runner-up is promoted over neutral once it reaches 60-80%
 * of it. On a mildly expressive face that is always true, which is why a live
 * session produced sad/angry/disgusted for every single record and never
 * neutral, happy or surprised.
 *
 *   node scripts/test-emotion-parse.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT_DIR, "worker", "node-detection-worker.mjs"), "utf8");
const start = src.indexOf("function parseEmotionFromExpressions(");
const end = src.indexOf("function isImageFileName(");
if (start < 0 || end < 0) throw new Error("cannot locate parseEmotionFromExpressions");
const parse = new Function(`${src.slice(start, end)}; return parseEmotionFromExpressions;`)();

const KEYS = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];
const argmax = (v) => KEYS.reduce((a, b) => ((v[b] ?? 0) > (v[a] ?? 0) ? b : a), KEYS[0]);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// Softmax shapes a calibrated model produces for these faces. The winner is
// what the model itself says; the question is whether the worker keeps it.
const CASES = [
  ["a resting face", { neutral: 0.52, sad: 0.18, disgusted: 0.12, angry: 0.08, happy: 0.05, fearful: 0.03, surprised: 0.02 }],
  ["a barely expressive face", { neutral: 0.35, sad: 0.3, disgusted: 0.15, angry: 0.1, happy: 0.05, fearful: 0.03, surprised: 0.02 }],
  ["a slight smile", { neutral: 0.34, happy: 0.33, sad: 0.12, disgusted: 0.1, angry: 0.06, fearful: 0.03, surprised: 0.02 }],
  ["a clear smile", { happy: 0.71, neutral: 0.16, sad: 0.05, disgusted: 0.04, surprised: 0.02, angry: 0.01, fearful: 0.01 }],
  ["mild surprise", { surprised: 0.38, neutral: 0.32, fearful: 0.12, happy: 0.1, sad: 0.04, disgusted: 0.02, angry: 0.02 }],
  ["real anger", { angry: 0.62, disgusted: 0.15, neutral: 0.1, sad: 0.08, fearful: 0.03, happy: 0.01, surprised: 0.01 }],
];

console.log("\ntrustModel=true — the model's own winner is reported\n");
for (const [label, vector] of CASES) {
  const got = parse(vector, KEYS, 0.5, true);
  const want = argmax(vector);
  check(`${label}: ${want}`, got.key === want, got.key === want ? "" : `reported ${got.key}`);
}

console.log("\ntrustModel=false — the face-api heuristic, for comparison\n");
let overridden = 0;
for (const [label, vector] of CASES) {
  const got = parse(vector, KEYS, 0.5, false);
  const want = argmax(vector);
  if (got.key !== want) overridden += 1;
  console.log(`  ${label}: model says ${want.padEnd(9)} heuristic says ${got.key}`);
}
check(
  "the heuristic does override the model (that is why it is off)",
  overridden > 0,
  `${overridden} of ${CASES.length} cases`,
);

console.log("\nshape of the result\n");
{
  const vector = CASES[0][1];
  const got = parse(vector, KEYS, 0.5, true);
  check("confidence is the model's own probability", got.confidence === vector.neutral, String(got.confidence));
  check("the full vector is preserved for averaging", KEYS.every((k) => got.vector[k] === (vector[k] ?? 0)));
  const empty = parse({}, KEYS, 0.5, true);
  check("an empty reading yields no label", empty.key === "" && empty.confidence === 0);
  const missing = parse(null, KEYS, 0.5, true);
  check("a missing reading yields no label", missing.key === "" && missing.confidence === 0);
}

console.log(failures ? `\n${failures} failing check(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
