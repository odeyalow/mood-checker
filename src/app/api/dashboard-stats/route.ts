import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    connectedCameras: 0,
    recognitionsLast24h: 0,
    negativePercent: 0,
    negativeDeltaVsPrevDay: 0,
    riskZoneCount: 0,
  });
}
