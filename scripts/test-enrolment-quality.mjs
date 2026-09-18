#!/usr/bin/env node
/*
 * Checks the two rules that decide an identity's reference frame:
 *   computeFaceQuality  (worker)  — how good a frame is as a reference
 *   shouldPromotePrimary (API)    — whether it replaces the stored one
 *
 * These decide what every later match is compared against, so they are worth
 * pinning down before the camera does it for us.
 *
 *   node scripts/test-enrolment-quality.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function extract(file, startMarker, endMarker, exported) {
  const src = fs.readFileSync(path.join(ROOT_DIR, file), "utf8");
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`cannot locate ${startMarker} in ${file}`);
  const body = src
    .slice(start, end)
    .replace(/export function/g, "function")
    .replace(/export const/g, "const");
  return new Function(`${body}; return ${exported};`)();
}

const computeFaceQuality = extract(
  "worker/node-detection-worker.mjs",
  "function computeFaceQuality(",
  "function createPresenceSession(",
  "computeFaceQuality",
);

// The TS source annotates the argument object; strip the type annotation so the
// same function body can run here.
const shouldPromotePrimary = (() => {
  const src = fs.readFileSync(path.join(ROOT_DIR, "src/lib/faces.ts"), "utf8");
  const start = src.indexOf("export function shouldPromotePrimary(");
  const end = src.indexOf("export function mergeDescriptor(", start);
  let body = src.slice(start, end).replace("export function", "function");
  body = body.replace(/\}: \{[\s\S]*?\}\) \{/, "}) {");
  body = body.replace(/minGain = FACE_PRIMARY_PROMOTE_MIN_GAIN/, "minGain = 0.08");
  body = body.replace(/maxDistance = FACE_PRIMARY_PROMOTE_MAX_DISTANCE/, "maxDistance = 0.5");
  return new Function(`${body}; return shouldPromotePrimary;`)();
})();

const targets = { sidePx: 110, sharpness: 16 };
let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
};

console.log("\ncomputeFaceQuality — a frame's worth as a reference\n");

// Numbers taken from the real log lines of a walk-past: the entering frame is
// small and soft, the frame in front of the camera is large and sharp.
const entering = computeFaceQuality({ score: 0.6, sidePx: 38, sharpness: 7 }, targets);
const closeUp = computeFaceQuality({ score: 0.87, sidePx: 120, sharpness: 18 }, targets);
const profile = computeFaceQuality(
  { score: 0.87, sidePx: 120, sharpness: 18, frontal: false },
  targets,
);
console.log(`  entering frame  ${entering}`);
console.log(`  close-up frame  ${closeUp}`);
console.log(`  same, profile   ${profile}`);
check("the close-up beats the entering frame", closeUp > entering, true);
check("a profile is worth half the same frontal frame", profile === closeUp / 2, true);
check("a perfect frame scores 1", computeFaceQuality({ score: 1, sidePx: 200, sharpness: 40 }, targets), 1);
check("nothing detected scores 0", computeFaceQuality({ score: 0, sidePx: 0, sharpness: 0 }, targets), 0);
check(
  "one bad factor sinks the frame",
  computeFaceQuality({ score: 0.9, sidePx: 120, sharpness: 1 }, targets) < 0.1,
  true,
);
check(
  "garbage input scores 0",
  computeFaceQuality({ score: NaN, sidePx: undefined, sharpness: null }, targets),
  0,
);

console.log("\nshouldPromotePrimary — does it replace the stored reference\n");

check(
  "a much better frame of a confident match is promoted",
  shouldPromotePrimary({ storedQuality: 0.2, incomingQuality: 0.55, matchDistance: 0.3 }),
  true,
);
check(
  "a marginally better frame is not",
  shouldPromotePrimary({ storedQuality: 0.5, incomingQuality: 0.53, matchDistance: 0.3 }),
  false,
);
check(
  "a worse frame is not",
  shouldPromotePrimary({ storedQuality: 0.6, incomingQuality: 0.3, matchDistance: 0.2 }),
  false,
);
check(
  "an uncertain match cannot rewrite a reference",
  shouldPromotePrimary({ storedQuality: 0.1, incomingQuality: 0.9, matchDistance: 0.62 }),
  false,
);
check(
  "a fresh identity (no match distance) is upgraded",
  shouldPromotePrimary({ storedQuality: null, incomingQuality: 0.4, matchDistance: 0 }),
  true,
);
check(
  "an identity from before quality tracking is upgraded",
  shouldPromotePrimary({ storedQuality: undefined, incomingQuality: 0.2, matchDistance: 0.4 }),
  true,
);
check(
  "an unmeasured incoming frame changes nothing",
  shouldPromotePrimary({ storedQuality: 0.3, incomingQuality: null, matchDistance: 0.2 }),
  false,
);
check(
  "a zero-quality frame changes nothing",
  shouldPromotePrimary({ storedQuality: 0, incomingQuality: 0, matchDistance: 0.2 }),
  false,
);

// The sequence a first-time visitor actually produces: enrolled from a poor
// frame, then a good one mid-visit, then jitter that must not keep rewriting.
console.log("\na first visit, frame by frame\n");
let stored = null;
const visit = [
  { score: 0.6, sidePx: 38, sharpness: 7 },
  { score: 0.72, sidePx: 60, sharpness: 11 },
  { score: 0.87, sidePx: 120, sharpness: 18 },
  { score: 0.85, sidePx: 118, sharpness: 17 },
  { score: 0.55, sidePx: 40, sharpness: 6 },
];
let promotions = 0;
for (const [i, frame] of visit.entries()) {
  const q = computeFaceQuality(frame, targets);
  const promote = shouldPromotePrimary({
    storedQuality: stored,
    incomingQuality: q,
    matchDistance: 0.3,
  });
  if (promote) {
    stored = q;
    promotions += 1;
  }
  console.log(
    `  frame ${i + 1}: side=${String(frame.sidePx).padStart(3)} sharp=${String(frame.sharpness).padStart(2)} ` +
      `quality=${q.toFixed(3)} ${promote ? "-> new reference" : ""}`,
  );
}
check("the visit settles on the best frame", stored, computeFaceQuality(visit[2], targets));
check("and does not rewrite on every frame", promotions <= 3, true);

console.log(failures ? `\n${failures} failing check(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
