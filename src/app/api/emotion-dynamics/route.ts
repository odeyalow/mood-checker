import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addMoodCount, bucketStartUtc, buildHourlyBuckets, toIso } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const items = await prisma.recognition.findMany({
      where: { detectedAt: { gte: since24h } },
      select: { detectedAt: true, mood: true, name: true },
    });

    const buckets = new Map();
    for (const item of items) {
      const bucket = bucketStartUtc(new Date(item.detectedAt));
      const key = bucket.toISOString();
      let entry = buckets.get(key);
      if (!entry) {
        entry = {
          bucketStart: key,
          positive: 0,
          neutral: 0,
          negative: 0,
          students: new Set(),
        };
        buckets.set(key, entry);
      }
      addMoodCount(entry, item.mood);
      entry.students.add(item.name);
    }

    const keys = buildHourlyBuckets(since24h, now);
    const points = keys.map((key) => {
      const bucket = buckets.get(key);
      if (!bucket) {
        return {
          bucketStart: key,
          totalStudents: 0,
          positiveCount: 0,
          neutralCount: 0,
          negativeCount: 0,
        };
      }
      return {
        bucketStart: bucket.bucketStart,
        totalStudents: bucket.students.size,
        positiveCount: bucket.positive,
        neutralCount: bucket.neutral,
        negativeCount: bucket.negative,
      };
    });

    const latestSnapshot = await prisma.emotionSnapshot.findFirst({
      orderBy: { bucketStart: "desc" },
    });

    return NextResponse.json({
      points,
      latestSnapshot: latestSnapshot
        ? {
            bucketStart: toIso(latestSnapshot.bucketStart),
            totalStudents: latestSnapshot.totalStudents,
            positiveCount: latestSnapshot.positiveCount,
            neutralCount: latestSnapshot.neutralCount,
            negativeCount: latestSnapshot.negativeCount,
          }
        : null,
    });
  } catch (error) {
    console.error("[api/emotion-dynamics] GET failed", error);
    return NextResponse.json({ points: [], latestSnapshot: null, error: "dynamics_unavailable" });
  }
}
