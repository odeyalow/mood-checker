import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, bucketStartUtc, computeRiskStats } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const studentId = decodeURIComponent(params.id || "").trim();
  if (!studentId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const items = await prisma.recognition.findMany({
    where: { name: studentId, detectedAt: { gte: since24h } },
    orderBy: { detectedAt: "desc" },
  });

  if (!items.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const counts = { positive: 0, neutral: 0, negative: 0 };
  items.forEach((item) => addMoodCount(counts, item.mood));
  const stats = computeRiskStats(counts);

  const dynamicsPointsMap = new Map();
  for (const item of items) {
    const bucket = bucketStartUtc(new Date(item.detectedAt));
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

  const dynamicsPoints = [...dynamicsPointsMap.values()].sort((a, b) =>
    a.bucketStart < b.bucketStart ? -1 : 1,
  );

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
    dynamics: items.map((item) => ({
      id: item.id,
      mood: item.mood,
      detectedAt: item.detectedAt.toISOString(),
    })),
    dynamicsPoints: dynamicsPoints.map((p) => ({
      bucketStart: p.bucketStart,
      positiveCount: p.positive,
      neutralCount: p.neutral,
      negativeCount: p.negative,
    })),
    recent: items.slice(0, 20).map((item) => ({
      id: item.id,
      mood: item.mood,
      detectedAt: item.detectedAt.toISOString(),
    })),
  });
}
