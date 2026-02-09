import { NextResponse } from "next/server";

type DetectionLogPayload = {
  cameraId?: string;
  cameraName?: string;
  faces?: number;
  status?: string;
  ts?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DetectionLogPayload;
    const cameraId = body.cameraId || "unknown";
    const cameraName = body.cameraName || "unknown";
    const faces = Number.isFinite(body.faces) ? Number(body.faces) : 0;
    const status = body.status || "unknown";
    const ts = body.ts || new Date().toISOString();

    // Visible in pm2 logs mood-checker-app
    console.log(
      `[camera-detect] ts=${ts} camera=${cameraId} name="${cameraName}" faces=${faces} status="${status}"`,
    );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}

