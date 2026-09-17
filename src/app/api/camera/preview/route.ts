import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves the worker's own preview of a camera: public/_worker-live/<cam>.jpg by
// default, or WORKER_PREVIEW_DIR (set it in .env, which both the app and the
// worker read; /dev/shm keeps the writes off the disk entirely).
//
// The dashboard tile uses this in NEXT_PUBLIC_CAMERA_PREVIEW_MODE=worker. The
// default mjpeg-proxy mode asks go2rtc for an MJPEG copy of the H265 main
// stream, and go2rtc answers by starting a SECOND ffmpeg transcode for as long
// as the dashboard is open — on a 4-core box that is the difference between
// whole frames and dropped, half-decoded ones for the detector. The worker
// already decodes every frame; a downscaled copy of its window costs ~10 ms.
const PREVIEW_DIR = process.env.WORKER_PREVIEW_DIR || path.join(process.cwd(), "public", "_worker-live");

export async function GET(req: NextRequest) {
  const cameraId = req.nextUrl.searchParams.get("cameraId") || "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cameraId)) {
    return new Response("invalid cameraId", { status: 400 });
  }
  const file = path.join(PREVIEW_DIR, `${cameraId}.jpg`);
  try {
    const [buf, st] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    if (!buf.length) throw new Error("empty");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Last-Modified": st.mtime.toUTCString(),
        "X-Preview-Age-Ms": String(Math.max(0, Math.round(Date.now() - st.mtimeMs))),
      },
    });
  } catch {
    // Either the worker is down or WORKER_PREVIEW_ENABLED is off.
    return new Response("preview unavailable", { status: 404 });
  }
}
