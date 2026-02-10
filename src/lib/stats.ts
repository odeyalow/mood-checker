import { classifyMood, type MoodKind } from "@/lib/mood";

export type MoodCounts = {
  positive: number;
  neutral: number;
  negative: number;
};

export type RiskStats = {
  total: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  positivePercent: number;
  neutralPercent: number;
  negativePercent: number;
  riskPercent: number;
  riskByRule: boolean;
};

export function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function addMoodCount(counts: MoodCounts, mood: string) {
  const kind: MoodKind = classifyMood(mood);
  if (kind === "negative") counts.negative += 1;
  else if (kind === "positive") counts.positive += 1;
  else counts.neutral += 1;
}

export function computeRiskStats(counts: MoodCounts): RiskStats {
  const total = counts.positive + counts.neutral + counts.negative;
  const positivePercent = total ? (counts.positive / total) * 100 : 0;
  const neutralPercent = total ? (counts.neutral / total) * 100 : 0;
  const negativePercent = total ? (counts.negative / total) * 100 : 0;

  const riskScore = counts.negative + Math.max(0, counts.neutral - counts.positive);
  const riskPercent = total ? (riskScore / total) * 100 : 0;

  return {
    total,
    positiveCount: counts.positive,
    neutralCount: counts.neutral,
    negativeCount: counts.negative,
    positivePercent: clampPercent(positivePercent),
    neutralPercent: clampPercent(neutralPercent),
    negativePercent: clampPercent(negativePercent),
    riskPercent: clampPercent(riskPercent),
    riskByRule: clampPercent(negativePercent) >= 40 || clampPercent(riskPercent) >= 50,
  };
}

export function bucketStartUtc(date: Date, minutes = 60) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  const bucketMins = Math.floor(mins / minutes) * minutes;
  d.setUTCMinutes(bucketMins);
  return d;
}

export function toIso(date: Date) {
  return date.toISOString();
}

export function hourStartUtc(date: Date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function buildHourlyBuckets(from: Date, to: Date, maxBuckets = 24 * 14) {
  const start = hourStartUtc(from);
  const end = hourStartUtc(to);
  const out: string[] = [];
  const cursor = new Date(start);

  while (cursor <= end && out.length < maxBuckets) {
    out.push(cursor.toISOString());
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  if (!out.length) {
    out.push(hourStartUtc(new Date()).toISOString());
  }
  return out;
}
