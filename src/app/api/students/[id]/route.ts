import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, bucketStartUtc, buildAdaptiveBuckets, computeRiskStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const studentId = decodeURIComponent(id || "").trim();
  if (!studentId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const items = await prisma.recognition.findMany({
    where: { name: studentId },
    orderBy: { detectedAt: "asc" },
  });

  if (!items.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const item of items) addMoodCount(counts, item.mood);
  const stats = computeRiskStats(counts);

  const from = items[0]?.detectedAt ? new Date(items[0].detectedAt) : new Date();
  const to = items[items.length - 1]?.detectedAt ? new Date(items[items.length - 1].detectedAt) : new Date();
  const { bucketMinutes, buckets } = buildAdaptiveBuckets(from, to);

  const dynamicsPointsMap = new Map();
  for (const item of items) {
    const bucket = bucketStartUtc(new Date(item.detectedAt), bucketMinutes);
    const key = bucket.toISOString();
    const entry = dynamicsPointsMap.get(key) || {
      bucketStart: key,
      positive: 0,
      neutral: 0,
      negative: 0,
    };
    addMoodCount(entry, item.mood);
    dynamicsPointsMap.set(key, entry);
  }

  const dynamicsPoints = buckets.map((bucketStart) => {
    const point = dynamicsPointsMap.get(bucketStart);
    if (!point) {
      return {
        bucketStart,
        positive: 0,
        neutral: 0,
        negative: 0,
      };
    }
    return point;
  });

  return NextResponse.json({
    student: {
      id: studentId,
      name: studentId,
      firstLetter: studentId[0]?.toUpperCase() ?? "?",
    },
    stats24h: {
      totalRecognitions: stats.total,
      positivePercent: stats.positivePercent,
      neutralPercent: stats.neutralPercent,
      negativePercent: stats.negativePercent,
      positiveCount: stats.positiveCount,
      neutralCount: stats.neutralCount,
      negativeCount: stats.negativeCount,
      riskPercent: stats.riskPercent,
      riskByRule: stats.riskByRule,
      ruleText: stats.riskByRule ? "Risk alert" : "Normal",
    },
    dynamics: items.map((item: { id: string; mood: string; detectedAt: Date }) => ({
      id: item.id,
      mood: item.mood,
      detectedAt: item.detectedAt.toISOString(),
    })),
    dynamicsPoints: dynamicsPoints.map((p: { bucketStart: string; positive: number; neutral: number; negative: number }) => ({
      bucketStart: p.bucketStart,
      positiveCount: p.positive,
      neutralCount: p.neutral,
      negativeCount: p.negative,
    })),
    recent: items.slice().reverse().slice(0, 20).map((item: { id: string; mood: string; detectedAt: Date }) => ({
      id: item.id,
      mood: item.mood,
      detectedAt: item.detectedAt.toISOString(),
    })),
  });
}
