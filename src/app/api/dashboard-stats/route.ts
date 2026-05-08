import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import { addMoodCount, computeRiskStats, type MoodCounts } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const recent = await prisma.recognition.findMany({
      select: { mood: true, name: true },
    });

    const recentCounts: MoodCounts = { positive: 0, neutral: 0, negative: 0 };
    for (const item of recent) {
      addMoodCount(recentCounts, item.mood);
    }
    const recentStats = computeRiskStats(recentCounts);

    const byName = new Map<string, MoodCounts>();
    for (const item of recent) {
      const entry = byName.get(item.name) || { positive: 0, neutral: 0, negative: 0 };
      addMoodCount(entry, item.mood);
      byName.set(item.name, entry);
    }
    let riskZoneCount = 0;
    for (const counts of byName.values()) {
      const stats = computeRiskStats(counts);
      if (stats.riskByRule) riskZoneCount += 1;
    }

    return NextResponse.json({
      connectedCameras: CAMERA_CONFIGS.length,
      recognitionsLast24h: recent.length,
      negativePercent: recentStats.negativePercent,
      negativeDeltaVsPrevDay: 0,
      riskZoneCount,
    });
  } catch (error) {
    console.error("[api/dashboard-stats] GET failed", error);
    return NextResponse.json({
      connectedCameras: CAMERA_CONFIGS.length,
      recognitionsLast24h: 0,
      negativePercent: 0,
      negativeDeltaVsPrevDay: 0,
      riskZoneCount: 0,
      error: "stats_unavailable",
    });
  }
}
