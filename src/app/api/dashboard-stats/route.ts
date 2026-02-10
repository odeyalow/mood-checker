import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import { addMoodCount, computeRiskStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const prev24h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const [recent, previous] = await Promise.all([
      prisma.recognition.findMany({
        where: { detectedAt: { gte: since24h } },
        select: { mood: true, name: true },
      }),
      prisma.recognition.findMany({
        where: { detectedAt: { gte: prev24h, lt: since24h } },
        select: { mood: true },
      }),
    ]);

    const recentCounts = { positive: 0, neutral: 0, negative: 0 };
    recent.forEach((item) => addMoodCount(recentCounts, item.mood));
    const recentStats = computeRiskStats(recentCounts);

    const prevCounts = { positive: 0, neutral: 0, negative: 0 };
    previous.forEach((item) => addMoodCount(prevCounts, item.mood));
    const prevStats = computeRiskStats(prevCounts);

    const negativeDeltaVsPrevDay = recentStats.negativePercent - prevStats.negativePercent;

    const byName = new Map();
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
      negativeDeltaVsPrevDay,
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
