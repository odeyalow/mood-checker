#!/usr/bin/env node
/*
 * The two decisions that caused the last round of complaints, run against the
 * situations that produced them.
 *
 *   decideMatch     — is the best candidate this person?
 *   decideEnrolment — if not, may this face become a NEW identity?
 *
 * Both failures came from the same place and pull in opposite directions: a
 * known face in a poor frame lands just PAST the threshold (and was enrolled
 * again, giving one person three identities), while a stranger with a similar
 * head lands just INSIDE it (and was filed under someone else). A single
 * distance cannot separate those, which is why the margin and the grey band
 * exist.
 *
 *   node scripts/test-match-decisions.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT_DIR, "worker", "node-detection-worker.mjs"), "utf8");
const start = src.indexOf("function decideMatch(");
const end = src.indexOf("function computeMatchCandidates(");
if (start < 0 || end < 0) throw new Error("cannot locate the decision functions");
const { decideMatch, decideEnrolment } = new Function(
  `${src.slice(start, end)}; return { decideMatch, decideEnrolment };`,
)();

// The server's settings.
const TH = 0.62;
const MIN_MARGIN = 0.04;
const VERY_CLOSE = 0.25;
const GREY = 0.15;

let failures = 0;
const check = (label, actual, expected, detail = "") => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

console.log(`\ndecideMatch — threshold ${TH}, margin ${MIN_MARGIN}, exemption below ${(TH - VERY_CLOSE).toFixed(2)}\n`);
const m = (distance, margin) =>
  decideMatch({ distance, margin, threshold: TH, minMargin: MIN_MARGIN, veryCloseDelta: VERY_CLOSE });

check("the same person, clean frame (0.25)", m(0.25, 0.6), true);
check("the same person, ordinary frame (0.45)", m(0.45, 0.4), true);
check("the same person, poor frame (0.58) with a clear field", m(0.58, 0.3), true);
check("a stranger who resembles them (0.64)", m(0.64, 0.3), false, "past the threshold");
check("a stranger at 0.72", m(0.72, 0.5), false);
check("two identities equally close (0.55, margin 0.02)", m(0.55, 0.02), false, "ambiguous");
check("very close match ignores a thin margin (0.3)", m(0.3, 0.01), true);
check("but 0.55 with a thin margin does not", m(0.55, 0.01), false);
check("no distance at all", m(Number.NaN, 1), false);

console.log(`\ndecideEnrolment — grey band up to ${(TH + GREY).toFixed(2)}\n`);
const e = (bestDistance, fullGate, softGate) =>
  decideEnrolment({ bestDistance, threshold: TH, greyBand: GREY, fullGate, softGate });

// The reported failure: a known face, poorly seen, enrolled again from one frame.
check(
  "known face at 0.70, single frame: held back",
  e(0.7, false, true).allowed,
  false,
  "this is what created the duplicate identities",
);
check("known face at 0.70, confirmed over several frames: allowed", e(0.7, true, true).allowed, true);
check("genuinely new face (nearest 0.95), single frame: allowed", e(0.95, false, true).allowed, true);
check("empty registry (no candidate), single frame: allowed", e(Number.POSITIVE_INFINITY, false, true).allowed, true);
check("new face but no gate passed at all: refused", e(0.95, false, false).allowed, false);
check("nearest 0.78 is outside the band", e(0.78, false, true).nearKnown, false);
check("nearest 0.77 is inside the band", e(0.77, false, true).nearKnown, true);

// The two complaints, end to end.
console.log("\nthe reported cases\n");
{
  const stranger = m(0.64, 0.3);
  const knownPoorFrame = m(0.7, 0.4);
  const enrolAfterMiss = e(0.7, false, true).allowed;
  check("stranger with a similar head is NOT filed under the known person", stranger, false);
  check("known person in a poor frame is not matched either", knownPoorFrame, false, "expected");
  check("...but no duplicate identity is created from that one frame", enrolAfterMiss, false);
  console.log(
    "\n  So the poor frame produces nothing at all, and the next decent frame of\n" +
      "  the same person matches normally. Previously it produced a new identity.\n",
  );
}

console.log(failures ? `\n${failures} failing check(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
