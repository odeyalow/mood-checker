import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, bucketStartUtc, buildAdaptiveBuckets, computeRiskStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseRange(request: Request) {
  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (fromParam && toParam) {
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from, to };
    }
  }

  if (!daysParam || String(daysParam).trim().toLowerCase() === "all") {
    return null;
  }

  const now = new Date();
  const days = Number(daysParam);
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(3650, days)) : 30;
  return { from: new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000), to: now };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const studentId = decodeURIComponent(id || "").trim();
  if (!studentId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const explicitRange = parseRange(request);
  let from = explicitRange?.from ?? null;
  const to = explicitRange?.to ?? new Date();

  if (!from) {
    const firstRecognition = await prisma.recognition.findFirst({
      where: { name: studentId },
      orderBy: { detectedAt: "asc" },
      select: { detectedAt: true },
    });
    from = firstRecognition?.detectedAt ? new Date(firstRecognition.detectedAt) : new Date();
  }

  const items = await prisma.recognition.findMany({
    where: { name: studentId, detectedAt: { gte: from, lte: to } },
    orderBy: { detectedAt: "asc" },
  });

  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const item of items) addMoodCount(counts, item.mood);
  const stats = computeRiskStats(counts);

  const { bucketMinutes, buckets } = buildAdaptiveBuckets(from, to);
  const pointsMap = new Map();
  for (const item of items) {
    const bucket = bucketStartUtc(new Date(item.detectedAt), bucketMinutes);
    const key = bucket.toISOString();
    const entry = pointsMap.get(key) || {
      bucketStart: key,
      positive: 0,
      neutral: 0,
      negative: 0,
    };
    addMoodCount(entry, item.mood);
    pointsMap.set(key, entry);
  }

  const points = buckets.map((bucketStart) => {
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

  return NextResponse.json({
    stats: {
      riskCount: counts.negative,
      riskByRule: stats.riskByRule,
      riskScore: stats.riskPercent,
      negativePercent: stats.negativePercent,
      recognitionsCount: items.length,
      positiveCount: counts.positive,
      neutralCount: counts.neutral,
      negativeCount: counts.negative,
    },
    points: points.map((p: { bucketStart: string; positive: number; neutral: number; negative: number }) => ({
      bucketStart: p.bucketStart,
      positiveCount: p.positive,
      neutralCount: p.neutral,
      negativeCount: p.negative,
    })),
    recent: items.slice().reverse().slice(0, 30).map((item: { id: string; mood: string; detectedAt: Date }) => ({
      id: item.id,
      mood: item.mood,
      detectedAt: item.detectedAt.toISOString(),
    })),
  });
}
