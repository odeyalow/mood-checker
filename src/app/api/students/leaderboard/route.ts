import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, computeRiskStats, type MoodCounts } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50)));

  const items = await prisma.recognition.findMany({
    select: { name: true, mood: true, detectedAt: true },
  });

  const byName = new Map<
    string,
    MoodCounts & { last: { mood: string; detectedAt: Date } | null }
  >();
  for (const item of items) {
    const entry =
      byName.get(item.name) || { positive: 0, neutral: 0, negative: 0, last: null };
    addMoodCount(entry, item.mood);
    if (!entry.last || new Date(item.detectedAt) > new Date(entry.last.detectedAt)) {
      entry.last = { mood: item.mood, detectedAt: item.detectedAt };
    }
    byName.set(item.name, entry);
  }

  const list: Array<{
    id: string;
    name: string;
    riskPercent: number;
    lastMood: string;
    lastDetectedAt: Date | string;
    totals: MoodCounts;
  }> = [];
  for (const [name, counts] of byName.entries()) {
    const stats = computeRiskStats(counts);
    list.push({
      id: name,
      name,
      riskPercent: stats.riskPercent,
      lastMood: counts.last?.mood ?? "neutral",
      lastDetectedAt: counts.last?.detectedAt ?? new Date().toISOString(),
      totals: {
        positive: counts.positive,
        neutral: counts.neutral,
        negative: counts.negative,
      },
    });
  }

  list.sort((a, b) => b.riskPercent - a.riskPercent);
  const itemsOut = list.slice(0, limit).map((item, index) => ({
    rank: index + 1,
    ...item,
  }));

  return NextResponse.json({ items: itemsOut });
}
