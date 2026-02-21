import { NextResponse } from "next/server";
import fs from "node:fs/promises";

type WorkerStatusCamera = {
  candidate: number;
  confirmed: number;
  score: number;
  motion: number;
  streak: number;
  requiredFrames: number;
  matchedNames?: string[];
  matchDistance?: number;
  personInFrame?: boolean;
  faceInFrame?: boolean;
  emotionSummary?: string;
  topEmotion?: string;
  people?: { name: string; emotion?: string; distance?: number }[];
  snapshotUrl?: string;
  lastRecognitionAt?: string;
  frameOk?: boolean;
  lastFrameAt?: string;
  lastFrameBytes?: number;
  frameWidth?: number;
  frameHeight?: number;
  frameError?: string;
};

type WorkerStatusPayload = {
  ts: string;
  cameras: Record<string, WorkerStatusCamera>;
};

const STATUS_FILE = process.env.WORKER_STATUS_FILE || "/tmp/mood-checker-worker-status.json";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cameraId = url.searchParams.get("cameraId") || "";

  try {
    const raw = await fs.readFile(STATUS_FILE, "utf-8");
    const stat = await fs.stat(STATUS_FILE).catch(() => null);
    const payload = JSON.parse(raw) as WorkerStatusPayload;

    if (cameraId) {
      return NextResponse.json(
        {
          ts: payload.ts,
          now: new Date().toISOString(),
          statusFileMtime: stat?.mtime?.toISOString() || "",
          cameraId,
          status: payload.cameras?.[cameraId] || null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ts: new Date().toISOString(),
        now: new Date().toISOString(),
        cameraId,
        status: null,
        error: error instanceof Error ? error.message : "status_read_failed",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
