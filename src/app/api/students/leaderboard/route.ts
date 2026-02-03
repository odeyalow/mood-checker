import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMood } from "@/lib/mood";
import { studentIdFromName } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseLimit(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function riskPercent(positive: number, neutral: number, negative: number) {
  const total = positive + neutral + negative;
  if (total === 0) return 0;
  const neutralOverPositive = Math.max(0, neutral - positive);
  return Math.round(((negative + neutralOverPositive) / total) * 100);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"), 20);
  const since = new Date(Date.now() - DAY_MS);

  const recognitions = await prisma.recognition.findMany({
    where: { detectedAt: { gte: since } },
    orderBy: { detectedAt: "desc" },
    select: { name: true, mood: true, detectedAt: true },
  });

  const byStudent = new Map<
    string,
    {
      positive: number;
      neutral: number;
      negative: number;
      lastMood: string;
      lastDetectedAt: string;
    }
  >();

  for (const rec of recognitions) {
    const moodType = classifyMood(rec.mood);
    const current = byStudent.get(rec.name) ?? {
      positive: 0,
      neutral: 0,
      negative: 0,
      lastMood: rec.mood,
      lastDetectedAt: rec.detectedAt.toISOString(),
    };

    current[moodType] += 1;
    if (!byStudent.has(rec.name)) {
      current.lastMood = rec.mood;
      current.lastDetectedAt = rec.detectedAt.toISOString();
    }
    byStudent.set(rec.name, current);
  }

  const items = Array.from(byStudent.entries())
    .map(([name, stats]) => ({
      id: studentIdFromName(name),
      name,
      riskPercent: riskPercent(stats.positive, stats.neutral, stats.negative),
      lastMood: stats.lastMood,
      lastDetectedAt: stats.lastDetectedAt,
      totals: {
        positive: stats.positive,
        neutral: stats.neutral,
        negative: stats.negative,
      },
    }))
    .sort((a, b) => b.riskPercent - a.riskPercent)
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return NextResponse.json({ items });
}
