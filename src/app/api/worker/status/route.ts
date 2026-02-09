import { NextResponse } from "next/server";
import fs from "node:fs/promises";

type WorkerStatusCamera = {
  candidate: number;
  confirmed: number;
  score: number;
  motion: number;
  streak: number;
  requiredFrames: number;
};

type WorkerStatusPayload = {
  ts: string;
  cameras: Record<string, WorkerStatusCamera>;
};

const STATUS_FILE = process.env.WORKER_STATUS_FILE || "/tmp/mood-checker-worker-status.json";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cameraId = url.searchParams.get("cameraId") || "";

  try {
    const raw = await fs.readFile(STATUS_FILE, "utf-8");
    const payload = JSON.parse(raw) as WorkerStatusPayload;

    if (cameraId) {
      return NextResponse.json(
        {
          ts: payload.ts,
          cameraId,
          status: payload.cameras?.[cameraId] || null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { ts: new Date().toISOString(), cameraId, status: null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

