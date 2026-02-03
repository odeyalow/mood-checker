import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMood } from "@/lib/mood";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MINUTE_MS = 60 * 1000;
const WINDOW_MINUTES = 24 * 60;
const WINDOW_MS = WINDOW_MINUTES * MINUTE_MS;

type MinutePoint = {
  bucketStart: string;
  totalStudents: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

function floorToMinute(date: Date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

function toBucketDate(date: Date) {
  const ms = Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(ms);
}

function toMinuteIso(date: Date) {
  return date.toISOString().slice(0, 16) + ":00.000Z";
}

export async function GET() {
  const now = new Date();
  const currentBucket = floorToMinute(now);
  const currentBucketMs = currentBucket.getTime();
  const minuteStart = new Date(currentBucketMs);
  const windowStart = new Date(currentBucketMs - WINDOW_MS + MINUTE_MS);

  const minuteRecognitions = await prisma.recognition.findMany({
    where: {
      detectedAt: {
        gte: minuteStart,
        lt: new Date(currentBucketMs + MINUTE_MS),
      },
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
  const studentLatestInMinute = new Map<
    string,
    { emotion: string; detectedAt: string }
  >();

  for (const rec of minuteRecognitions) {
    const moodKind = classifyMood(rec.mood);
    if (moodKind === "positive") positiveCount += 1;
    else if (moodKind === "negative") negativeCount += 1;
    else neutralCount += 1;

    const detectedAtIso = rec.detectedAt.toISOString();
    const current = studentLatestInMinute.get(rec.name);
    if (!current || detectedAtIso > current.detectedAt) {
      studentLatestInMinute.set(rec.name, {
        emotion: rec.mood,
        detectedAt: detectedAtIso,
      });
    }
  }

  const snapshot = await prisma.emotionSnapshot.upsert({
    where: {
      bucketStart: minuteStart,
    },
    create: {
      bucketStart: minuteStart,
      totalStudents: studentLatestInMinute.size,
      positiveCount,
      neutralCount,
      negativeCount,
      students: Array.from(studentLatestInMinute.entries()).map(
        ([name, data]) => ({
          name,
          emotion: data.emotion,
          detectedAt: data.detectedAt,
        })
      ),
      recognitions: minuteRecognitions.map((rec) => ({
        name: rec.name,
        emotion: rec.mood,
        detectedAt: rec.detectedAt.toISOString(),
      })),
    },
    update: {
      totalStudents: studentLatestInMinute.size,
      positiveCount,
      neutralCount,
      negativeCount,
      students: Array.from(studentLatestInMinute.entries()).map(
        ([name, data]) => ({
          name,
          emotion: data.emotion,
          detectedAt: data.detectedAt,
        })
      ),
      recognitions: minuteRecognitions.map((rec) => ({
        name: rec.name,
        emotion: rec.mood,
        detectedAt: rec.detectedAt.toISOString(),
      })),
    },
  });

  await prisma.emotionSnapshot.deleteMany({
    where: {
      bucketStart: {
        lt: windowStart,
      },
    },
  });

  const snapshotRows = await prisma.emotionSnapshot.findMany({
    where: {
      bucketStart: {
        gte: windowStart,
      },
    },
    orderBy: {
      bucketStart: "asc",
    },
    select: {
      bucketStart: true,
      totalStudents: true,
      positiveCount: true,
      neutralCount: true,
      negativeCount: true,
    },
  });

  const pointsByMinute = new Map<string, MinutePoint>();
  for (const row of snapshotRows) {
    pointsByMinute.set(toMinuteIso(row.bucketStart), {
      bucketStart: row.bucketStart.toISOString(),
      totalStudents: row.totalStudents,
      positiveCount: row.positiveCount,
      neutralCount: row.neutralCount,
      negativeCount: row.negativeCount,
    });
  }

  const points: MinutePoint[] = [];
  for (
    let t = currentBucketMs - WINDOW_MS + MINUTE_MS;
    t <= currentBucketMs;
    t += MINUTE_MS
  ) {
    const bucketDate = toBucketDate(new Date(t));
    const key = toMinuteIso(bucketDate);
    points.push(
      pointsByMinute.get(key) ?? {
        bucketStart: bucketDate.toISOString(),
        totalStudents: 0,
        positiveCount: 0,
        neutralCount: 0,
        negativeCount: 0,
      }
    );
  }

  return NextResponse.json({
    points,
    latestSnapshot: {
      bucketStart: snapshot.bucketStart.toISOString(),
      totalStudents: snapshot.totalStudents,
      positiveCount: snapshot.positiveCount,
      neutralCount: snapshot.neutralCount,
      negativeCount: snapshot.negativeCount,
      students: snapshot.students,
      recognitions: snapshot.recognitions,
    },
  });
}
