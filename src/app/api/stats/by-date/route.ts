import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, bucketStartUtc, buildHourlyBuckets, computeRiskStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseRange(request: Request) {
  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const now = new Date();
  if (fromParam && toParam) {
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from, to };
    }
  }

  const days = daysParam ? Number(daysParam) : 2;
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(14, days)) : 2;
  const from = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return { from, to: now };
}

export async function GET(request: Request) {
  const { from, to } = parseRange(request);

  const items = await prisma.recognition.findMany({
    where: { detectedAt: { gte: from, lte: to } },
    select: { detectedAt: true, mood: true, name: true },
  });

  const counts = { positive: 0, neutral: 0, negative: 0 };
  const byName = new Map();
  for (const item of items) {
    addMoodCount(counts, item.mood);
    const entry = byName.get(item.name) || { positive: 0, neutral: 0, negative: 0 };
    addMoodCount(entry, item.mood);
    byName.set(item.name, entry);
  }

  const stats = computeRiskStats(counts);
  const pointsMap = new Map();
  for (const item of items) {
    const bucket = bucketStartUtc(new Date(item.detectedAt));
    const key = bucket.toISOString();
    const entry = pointsMap.get(key) || { bucketStart: key, positive: 0, neutral: 0, negative: 0 };
    addMoodCount(entry, item.mood);
    pointsMap.set(key, entry);
  }

  const points = buildHourlyBuckets(from, to).map((bucketStart) => {
    const p = pointsMap.get(bucketStart);
    if (!p) {
      return {
        bucketStart,
        positive: 0,
        neutral: 0,
        negative: 0,
      };
    }
    return p;
  });

  const students = [...byName.entries()]
    .map(([name, c]) => {
      const s = computeRiskStats(c);
      const riskScore = c.negative + Math.max(0, c.neutral - c.positive);
      return {
        id: name,
        name,
        positiveCount: c.positive,
        neutralCount: c.neutral,
        negativeCount: c.negative,
        riskScore,
        riskPercent: s.riskPercent,
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 20);

  return NextResponse.json({
    range: { from: from.toISOString(), to: to.toISOString() },
    stats: {
      riskCount: counts.negative,
      negativePercent: stats.negativePercent,
      recognitionsCount: items.length,
      positiveCount: counts.positive,
      neutralCount: counts.neutral,
      negativeCount: counts.negative,
    },
    points: points.map((p) => ({
      bucketStart: p.bucketStart,
      positiveCount: p.positive,
      neutralCount: p.neutral,
      negativeCount: p.negative,
    })),
    students: students.map((s) => ({
      id: s.id,
      name: s.name,
      positiveCount: s.positiveCount,
      neutralCount: s.neutralCount,
      negativeCount: s.negativeCount,
      riskScore: Math.round(s.riskScore),
    })),
  });
}
