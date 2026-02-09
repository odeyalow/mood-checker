import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    range: null,
    stats: {
      riskCount: 0,
      negativePercent: 0,
      recognitionsCount: 0,
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
    },
    points: [],
    students: [],
  });
}
