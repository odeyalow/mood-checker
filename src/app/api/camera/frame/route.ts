import { NextRequest } from "next/server";

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
  const url = `${go2rtcBaseUrl}/api/frame.jpeg?src=${encodeURIComponent(src)}`;

  try {
    const upstream = await fetch(url, { cache: "no-store" });
    if (!upstream.ok) {
      const reason = await upstream.text().catch(() => "");
      return new Response(
        `go2rtc upstream status=${upstream.status} src=${src} body=${reason.slice(0, 300)}`,
        { status: 502 },
      );
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (error) {
    console.error("[camera-frame] proxy error:", error);
    return new Response("camera frame proxy error", { status: 500 });
  }
}
