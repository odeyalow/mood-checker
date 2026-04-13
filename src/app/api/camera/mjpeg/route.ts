import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_GO2RTC_BASE_URL = "http://127.0.0.1:1984";

function isValidSrc(value: string) {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") || "";
  if (!src || !isValidSrc(src)) {
    return new Response("invalid src", { status: 400 });
  }

  const go2rtcBaseUrl = process.env.GO2RTC_BASE_URL || DEFAULT_GO2RTC_BASE_URL;
  const upstreamUrl = new URL(go2rtcBaseUrl);
  upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, "")}/api/stream.mjpeg`;
  upstreamUrl.searchParams.set("src", src);

  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      cache: "no-store",
    });

    if (!upstream.ok || !upstream.body) {
      const reason = await upstream.text().catch(() => "");
      return new Response(
        `go2rtc upstream status=${upstream.status} src=${src} body=${reason.slice(0, 300)}`,
        { status: 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[camera-mjpeg] proxy error:", error);
    return new Response("camera mjpeg proxy error", { status: 500 });
  }
}
