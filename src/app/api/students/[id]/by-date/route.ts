import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMood } from "@/lib/mood";
import { studentNameFromId } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HOUR_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 31;

type RouteContext = {
  params: Promise<{ id: string }>;
};

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

export async function GET(request: Request, context: RouteContext) {
  const range = parseRange(request);
  if (!range) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  const { id } = await context.params;
  const studentName = studentNameFromId(id);

  const studentExists = await prisma.recognition.findFirst({
    where: { name: studentName },
    select: { id: true },
  });

  if (!studentExists) {
    return NextResponse.json({ error: "student_not_found" }, { status: 404 });
  }

  const recognitions = await prisma.recognition.findMany({
    where: {
      name: studentName,
      detectedAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    orderBy: {
      detectedAt: "asc",
    },
    select: {
      id: true,
      mood: true,
      detectedAt: true,
    },
  });

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;

  const byHour = new Map<
    number,
    { bucketStart: string; positiveCount: number; neutralCount: number; negativeCount: number }
  >();

  for (const rec of recognitions) {
    const moodType = classifyMood(rec.mood);
    if (moodType === "positive") positiveCount += 1;
    else if (moodType === "negative") negativeCount += 1;
    else neutralCount += 1;

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
  const riskByRule = negativeCount > 0 || neutralCount > positiveCount;
  const riskScore =
    totalRecognitions === 0
      ? 0
      : Math.round(((negativeCount * 2 + neutralCount) / (totalRecognitions * 2)) * 100);

  const points = Array.from(byHour.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);

  return NextResponse.json({
    student: {
      id,
      name: studentName,
    },
    range: {
      from: range.start.toISOString(),
      to: range.end.toISOString(),
    },
    stats: {
      riskCount: riskByRule ? 1 : 0,
      riskByRule,
      riskScore,
      negativePercent,
      recognitionsCount: totalRecognitions,
      positiveCount,
      neutralCount,
      negativeCount,
    },
    points,
    recent: recognitions
      .slice()
      .reverse()
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        mood: item.mood,
        detectedAt: item.detectedAt.toISOString(),
      })),
  });
}
