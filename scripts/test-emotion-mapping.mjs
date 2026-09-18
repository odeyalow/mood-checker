#!/usr/bin/env node
/*
 * Real readings from the camera, run through the three ways of handling the
 * model's eighth class.
 *
 * The model has eight classes and the UI has seven, so Contempt shares the
 * "disgusted" key with Disgust. Every one of these vectors was logged by the
 * live service (emotion_raw8) while a known expression was held in front of the
 * camera, so they show what that sharing actually costs:
 *
 *   smiling: Happiness 0.24-0.28, but Contempt 0.22-0.36 on top of Disgust
 *            0.15-0.21 — the shared key wins and every smile records as
 *            "disgusted".
 *
 *   node scripts/test-emotion-mapping.mjs
 */

const HSEMOTION_LABELS = [
  "Anger",
  "Contempt",
  "Disgust",
  "Fear",
  "Happiness",
  "Neutral",
  "Sadness",
  "Surprise",
];
const TO_KEY = {
  Anger: "angry",
  Contempt: "disgusted",
  Disgust: "disgusted",
  Fear: "fearful",
  Happiness: "happy",
  Neutral: "neutral",
  Sadness: "sad",
  Surprise: "surprised",
};
const KEYS = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];

/** Mirrors EmotionEngine.predict: fold eight classes into seven, renormalise if any were dropped. */
function fold(probs, contemptTarget) {
  const scores = Object.fromEntries(KEYS.map((k) => [k, 0]));
  let dropped = 0;
  HSEMOTION_LABELS.forEach((label, i) => {
    const target = label === "Contempt" ? contemptTarget : TO_KEY[label];
    if (target) scores[target] += probs[i];
    else dropped += probs[i];
  });
  if (dropped > 0) {
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (total > 0) for (const k of KEYS) scores[k] /= total;
  }
  return scores;
}
const winner = (s) => KEYS.reduce((a, b) => (s[b] > s[a] ? b : a), KEYS[0]);

// [Anger, Contempt, Disgust, Fear, Happiness, Neutral, Sadness, Surprise]
const SAMPLES = [
  ["smiling", "happy", [
    [0.037, 0.352, 0.160, 0.075, 0.240, 0.039, 0.057, 0.040],
    [0.030, 0.224, 0.190, 0.085, 0.267, 0.042, 0.119, 0.042],
    [0.055, 0.237, 0.209, 0.083, 0.247, 0.064, 0.059, 0.046],
    [0.034, 0.312, 0.154, 0.094, 0.191, 0.062, 0.115, 0.038],
    [0.026, 0.333, 0.151, 0.086, 0.276, 0.047, 0.049, 0.032],
    [0.033, 0.359, 0.159, 0.080, 0.255, 0.036, 0.047, 0.031],
  ]],
  ["angry", "angry", [
    [0.374, 0.076, 0.265, 0.048, 0.002, 0.062, 0.141, 0.031],
    [0.374, 0.094, 0.147, 0.061, 0.003, 0.086, 0.207, 0.029],
    [0.398, 0.097, 0.165, 0.064, 0.003, 0.100, 0.137, 0.035],
    [0.500, 0.074, 0.128, 0.049, 0.002, 0.047, 0.174, 0.026],
    [0.311, 0.093, 0.164, 0.077, 0.003, 0.100, 0.219, 0.034],
  ]],
  ["sad", "sad", [
    [0.208, 0.086, 0.161, 0.058, 0.003, 0.110, 0.338, 0.037],
    [0.265, 0.087, 0.155, 0.082, 0.003, 0.090, 0.288, 0.031],
  ]],
  ["unremarkable", "neutral", [
    [0.028, 0.135, 0.175, 0.108, 0.061, 0.192, 0.180, 0.121],
    [0.045, 0.134, 0.167, 0.118, 0.102, 0.193, 0.100, 0.140],
  ]],
];

const MAPPINGS = [
  ["disgusted", "Contempt -> disgusted (current)"],
  ["neutral", "Contempt -> neutral"],
  ["", "Contempt dropped"],
];

let failures = 0;
const tally = new Map(MAPPINGS.map(([m]) => [m, 0]));
let total = 0;

for (const [label, expected, vectors] of SAMPLES) {
  console.log(`\n${label} — expected "${expected}", ${vectors.length} frame(s)`);
  for (const [mapping, title] of MAPPINGS) {
    const winners = vectors.map((v) => winner(fold(v, mapping)));
    const hits = winners.filter((w) => w === expected).length;
    tally.set(mapping, tally.get(mapping) + hits);
    const counts = [...new Set(winners)].map((w) => `${w}x${winners.filter((x) => x === w).length}`);
    console.log(`  ${title.padEnd(32)} ${hits}/${vectors.length}  ${counts.join(" ")}`);
  }
  total += vectors.length;
}

console.log("\noverall, frames matching the expression that was actually held:\n");
for (const [mapping, title] of MAPPINGS) {
  const hits = tally.get(mapping);
  console.log(`  ${title.padEnd(32)} ${hits}/${total}  (${((hits / total) * 100).toFixed(0)}%)`);
}

// What the change has to achieve, stated as checks rather than prose.
const smiles = SAMPLES[0][2];
const smileNow = smiles.filter((v) => winner(fold(v, "disgusted")) === "happy").length;
const smileDropped = smiles.filter((v) => winner(fold(v, "")) === "happy").length;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
console.log("");
check("today: not one smile reads as happy", smileNow === 0, `${smileNow}/${smiles.length}`);
check("dropping Contempt: every smile reads as happy", smileDropped === smiles.length, `${smileDropped}/${smiles.length}`);
check(
  "anger and sadness are unaffected by the change",
  SAMPLES.slice(1, 3).every(([, expected, vectors]) =>
    vectors.every((v) => winner(fold(v, "")) === expected),
  ),
);
check("dropping Contempt is the best of the three", tally.get("") >= Math.max(...tally.values()));

console.log(failures ? `\n${failures} failing check(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
