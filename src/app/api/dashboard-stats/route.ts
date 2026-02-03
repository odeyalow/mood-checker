import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import { classifyMood } from "@/lib/mood";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

function calcNegativePercent(total: number, negative: number) {
  if (total <= 0) return 0;
  return Math.round((negative / total) * 100);
}

export async function GET() {
  const now = Date.now();
  const currentStart = new Date(now - DAY_MS);
  const previousStart = new Date(now - DAY_MS * 2);

  const recognitions = await prisma.recognition.findMany({
    where: {
      detectedAt: {
        gte: previousStart,
      },
    },
    select: {
      name: true,
      mood: true,
      detectedAt: true,
    },
  });

  let currentTotal = 0;
  let currentNegative = 0;
  let previousTotal = 0;
  let previousNegative = 0;
  const perPerson = new Map<
    string,
    { positive: number; neutral: number; negative: number }
  >();

  for (const item of recognitions) {
    const detectedAtMs = item.detectedAt.getTime();
    const moodType = classifyMood(item.mood);

    if (detectedAtMs >= currentStart.getTime()) {
      currentTotal += 1;
      if (moodType === "negative") currentNegative += 1;

      const stats = perPerson.get(item.name) ?? {
        positive: 0,
        neutral: 0,
        negative: 0,
      };
      stats[moodType] += 1;
      perPerson.set(item.name, stats);
      continue;
    }

    previousTotal += 1;
    if (moodType === "negative") previousNegative += 1;
  }

  let riskZoneCount = 0;
  for (const stats of perPerson.values()) {
    if (stats.negative > 0 || stats.neutral > stats.positive) {
      riskZoneCount += 1;
    }
  }

  const currentNegativePercent = calcNegativePercent(currentTotal, currentNegative);
  const previousNegativePercent = calcNegativePercent(previousTotal, previousNegative);

  return NextResponse.json({
    connectedCameras: CAMERA_CONFIGS.length,
    recognitionsLast24h: currentTotal,
    negativePercent: currentNegativePercent,
    negativeDeltaVsPrevDay: currentNegativePercent - previousNegativePercent,
    riskZoneCount,
  });
}
