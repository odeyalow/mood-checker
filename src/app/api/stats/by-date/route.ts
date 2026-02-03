import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMood } from "@/lib/mood";
import { studentIdFromName } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HOUR_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 31;

function parseRange(request: Request) {
  const { searchParams } = new URL(request.url);
  const daysParam = Number.parseInt(searchParams.get("days") ?? "", 10);

  if ([2, 3, 5].includes(daysParam)) {
    const end = new Date();
    const start = new Date(end.getTime() - daysParam * 24 * HOUR_MS);
    return { start, end };
  }

  const fromRaw = searchParams.get("from");
  const toRaw = searchParams.get("to");
  if (!fromRaw || !toRaw) return null;

  const start = new Date(fromRaw);
  const end = new Date(toRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (start >= end) return null;
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * HOUR_MS) return null;

  return { start, end };
}

function toHourBucket(date: Date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

export async function GET(request: Request) {
  const range = parseRange(request);
  if (!range) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  const recognitions = await prisma.recognition.findMany({
    where: {
      detectedAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    orderBy: {
      detectedAt: "asc",
    },
    select: {
      name: true,
      mood: true,
      detectedAt: true,
    },
  });

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;

  const byStudent = new Map<
    string,
    { positive: number; neutral: number; negative: number }
  >();
  const byHour = new Map<
    number,
    { bucketStart: string; positiveCount: number; neutralCount: number; negativeCount: number }
  >();

  for (const rec of recognitions) {
    const moodType = classifyMood(rec.mood);
    if (moodType === "positive") positiveCount += 1;
    else if (moodType === "negative") negativeCount += 1;
    else neutralCount += 1;

    const studentStats = byStudent.get(rec.name) ?? {
      positive: 0,
      neutral: 0,
      negative: 0,
    };
    studentStats[moodType] += 1;
    byStudent.set(rec.name, studentStats);

    const bucketMs = toHourBucket(rec.detectedAt).getTime();
    const bucket = byHour.get(bucketMs) ?? {
      bucketStart: new Date(bucketMs).toISOString(),
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
    };
    bucket[moodType === "positive" ? "positiveCount" : moodType === "negative" ? "negativeCount" : "neutralCount"] += 1;
    byHour.set(bucketMs, bucket);
  }

  const totalRecognitions = recognitions.length;
  const negativePercent =
    totalRecognitions === 0 ? 0 : Math.round((negativeCount / totalRecognitions) * 100);

  let riskCount = 0;
  const students = Array.from(byStudent.entries())
    .filter(([, stats]) => stats.negative + stats.neutral > stats.positive)
    .map(([name, stats]) => {
      const total = stats.positive + stats.neutral + stats.negative;
      const riskScore = total === 0 ? 0 : Math.round(((stats.negative * 2 + stats.neutral) / (total * 2)) * 100);
      const riskByRule = stats.negative > 0 || stats.neutral > stats.positive;
      if (riskByRule) riskCount += 1;
      return {
        id: studentIdFromName(name),
        name,
        positiveCount: stats.positive,
        neutralCount: stats.neutral,
        negativeCount: stats.negative,
        riskScore,
      };
    })
    .sort((a, b) => {
      if (b.negativeCount !== a.negativeCount) return b.negativeCount - a.negativeCount;
      if (b.neutralCount !== a.neutralCount) return b.neutralCount - a.neutralCount;
      return b.riskScore - a.riskScore;
    })
    .slice(0, 20);

  const points = Array.from(byHour.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);

  return NextResponse.json({
    range: {
      from: range.start.toISOString(),
      to: range.end.toISOString(),
    },
    stats: {
      riskCount,
      negativePercent,
      recognitionsCount: totalRecognitions,
      positiveCount,
      neutralCount,
      negativeCount,
    },
    points,
    students,
  });
}
