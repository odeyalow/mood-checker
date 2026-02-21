import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const ZOOM_STATE_FILE = process.env.WORKER_ZOOM_STATE_FILE || "/tmp/mood-checker-worker-zoom.json";
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function clampZoom(value: number) {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function isValidCameraId(value: string) {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

async function readZoomState() {
  try {
    const raw = await fs.readFile(ZOOM_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {} as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [cameraId, rawZoom] of Object.entries(parsed)) {
      const zoom = clampZoom(Number(rawZoom));
      out[cameraId] = zoom;
    }
    return out;
  } catch {
    return {} as Record<string, number>;
  }
}

async function writeZoomState(state: Record<string, number>) {
  const dir = path.dirname(ZOOM_STATE_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${ZOOM_STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), "utf-8");
  await fs.rename(tmp, ZOOM_STATE_FILE);
}

export async function GET(req: NextRequest) {
  const cameraId = (req.nextUrl.searchParams.get("cameraId") || "").trim();
  const state = await readZoomState();

  if (!cameraId) {
    return NextResponse.json({ zooms: state }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!isValidCameraId(cameraId)) {
    return NextResponse.json({ error: "invalid cameraId" }, { status: 400 });
  }

  return NextResponse.json(
    {
      cameraId,
      zoom: clampZoom(state[cameraId] ?? 1),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { cameraId?: string; zoom?: number };
    const cameraId = String(body?.cameraId ?? "").trim();
    const rawZoom = Number(body?.zoom);

    if (!cameraId || !isValidCameraId(cameraId)) {
      return NextResponse.json({ error: "invalid cameraId" }, { status: 400 });
    }
    if (!Number.isFinite(rawZoom)) {
      return NextResponse.json({ error: "invalid zoom" }, { status: 400 });
    }

    const zoom = clampZoom(rawZoom);
    const state = await readZoomState();
    state[cameraId] = zoom;
    await writeZoomState(state);

    return NextResponse.json(
      { ok: true, cameraId, zoom, zooms: state },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "zoom_update_failed" },
      { status: 500 },
    );
  }
}

