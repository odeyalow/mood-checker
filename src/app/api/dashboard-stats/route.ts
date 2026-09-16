import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import { addMoodCount, computeRiskStats, type MoodCounts } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyCounts(): MoodCounts {
  return { positive: 0, neutral: 0, negative: 0 };
}

/** One "risk zone" = an identity whose mood mix trips computeRiskStats.riskByRule. */
function countRiskIdentities(rows: Array<{ name: string; mood: string }>) {
  const byName = new Map<string, MoodCounts>();
  for (const row of rows) {
    const entry = byName.get(row.name) ?? emptyCounts();
    addMoodCount(entry, row.mood);
    byName.set(row.name, entry);
  }
  let count = 0;
  for (const counts of byName.values()) {
    if (computeRiskStats(counts).riskByRule) count += 1;
  }
  return count;
}

function statsFor(rows: Array<{ mood: string }>) {
  const counts = emptyCounts();
  for (const row of rows) addMoodCount(counts, row.mood);
  return computeRiskStats(counts);
}

export async function GET() {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);

    const [all, previousDay] = await Promise.all([
      prisma.recognition.findMany({ select: { mood: true, name: true, detectedAt: true } }),
      prisma.recognition.findMany({
        where: { detectedAt: { gte: twoDaysAgo, lt: dayAgo } },
        select: { mood: true },
      }),
    ]);

    // The dashboard tiles are labelled "За все время", so the headline numbers stay
    // all-time. The day windows exist so the delta below is a real comparison
    // rather than the hardcoded 0 it used to be.
    const lastDay = all.filter((item) => item.detectedAt >= dayAgo);
    const allStats = statsFor(all);
    const dayStats = statsFor(lastDay);
    const prevStats = statsFor(previousDay);

    return NextResponse.json({
      connectedCameras: CAMERA_CONFIGS.length,
      // Name kept for compatibility with the dashboard; the tile says "За все время".
      recognitionsLast24h: all.length,
      negativePercent: allStats.negativePercent,
      riskZoneCount: countRiskIdentities(all),

      // Percentage points, not a ratio: +12 means the negative share grew by 12 pp
      // versus the day before. Null when there is no previous day to compare with,
      // so the UI can stay silent instead of showing a confident 0.
      negativeDeltaVsPrevDay: previousDay.length
        ? dayStats.negativePercent - prevStats.negativePercent
        : null,

      // Breakdown of the mood mix and how many distinct faces it came from —
      // the "info parts built from the number of faces and their emotions".
      positivePercent: allStats.positivePercent,
      neutralPercent: allStats.neutralPercent,
      facesTotal: new Set(all.map((item) => item.name)).size,
      recognitionsLastDay: lastDay.length,
      facesLastDay: new Set(lastDay.map((item) => item.name)).size,
      riskZoneCountLastDay: countRiskIdentities(lastDay),
    });
  } catch (error) {
    console.error("[api/dashboard-stats] GET failed", error);
    return NextResponse.json({
      connectedCameras: CAMERA_CONFIGS.length,
      recognitionsLast24h: 0,
      negativePercent: 0,
      riskZoneCount: 0,
      negativeDeltaVsPrevDay: null,
      positivePercent: 0,
      neutralPercent: 0,
      facesTotal: 0,
      recognitionsLastDay: 0,
      facesLastDay: 0,
      riskZoneCountLastDay: 0,
      error: "stats_unavailable",
    });
  }
}
