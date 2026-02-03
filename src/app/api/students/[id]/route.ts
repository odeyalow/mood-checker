import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMood } from "@/lib/mood";
import { studentNameFromId } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function percent(part: number, total: number) {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

function calcRiskPercent(positive: number, neutral: number, negative: number) {
  const total = positive + neutral + negative;
  if (total === 0) return 0;
  const neutralOverPositive = Math.max(0, neutral - positive);
  return Math.round(((negative + neutralOverPositive) / total) * 100);
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const studentName = studentNameFromId(id);
  const since = new Date(Date.now() - DAY_MS);

  const recognitions = await prisma.recognition.findMany({
    where: { name: studentName },
    orderBy: { detectedAt: "desc" },
    take: 1000,
    select: { id: true, mood: true, detectedAt: true, name: true },
  });

  if (recognitions.length === 0) {
    return NextResponse.json({ error: "student_not_found" }, { status: 404 });
  }

  const dayRecognitions = recognitions.filter((r) => r.detectedAt >= since);
  let positive = 0;
  let neutral = 0;
  let negative = 0;

  const dynamicsMap = new Map<
    number,
    { bucketStart: string; positiveCount: number; neutralCount: number; negativeCount: number }
  >();

  for (const rec of dayRecognitions) {
    const moodType = classifyMood(rec.mood);
    if (moodType === "positive") positive += 1;
    else if (moodType === "negative") negative += 1;
    else neutral += 1;

    const bucketMs = Math.floor(rec.detectedAt.getTime() / MINUTE_MS) * MINUTE_MS;
    const currentBucket = dynamicsMap.get(bucketMs) ?? {
      bucketStart: new Date(bucketMs).toISOString(),
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
    };
    currentBucket[moodType === "positive" ? "positiveCount" : moodType === "negative" ? "negativeCount" : "neutralCount"] += 1;
    dynamicsMap.set(bucketMs, currentBucket);
  }

  const total24h = dayRecognitions.length;
  const riskByRule = negative > 0 || neutral > positive;
  const risk = calcRiskPercent(positive, neutral, negative);

  return NextResponse.json({
    student: {
      id,
      name: recognitions[0].name,
      firstLetter: recognitions[0].name[0] ?? "?",
    },
    stats24h: {
      totalRecognitions: total24h,
      positivePercent: percent(positive, total24h),
      neutralPercent: percent(neutral, total24h),
      negativePercent: percent(negative, total24h),
      positiveCount: positive,
      neutralCount: neutral,
      negativeCount: negative,
      riskPercent: risk,
      riskByRule,
      ruleText:
        "Риск = есть негативные эмоции ИЛИ нейтральных больше, чем позитивных.",
    },
    dynamics: dayRecognitions
      .slice()
      .reverse()
      .map((rec) => ({
        id: rec.id,
        mood: rec.mood,
        detectedAt: rec.detectedAt.toISOString(),
      })),
    dynamicsPoints: Array.from(dynamicsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value),
    recent: recognitions.slice(0, 15).map((rec) => ({
      id: rec.id,
      mood: rec.mood,
      detectedAt: rec.detectedAt.toISOString(),
    })),
  });
}
