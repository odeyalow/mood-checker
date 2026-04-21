import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_GO2RTC_BASE_URL = "http://127.0.0.1:1984";
const STALE_FRAME_MAX_AGE_MS = 10_000;

type CachedFrame = {
  body: Buffer;
  contentType: string;
  createdAt: number;
};

const staleFrameCache = new Map<string, CachedFrame>();

function isValidSrc(value: string) {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function parseIntParam(
  rawValue: string | null | undefined,
  min: number,
  max: number,
): number | null {
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function buildCacheKey(
  src: string,
  width: number | null,
  height: number | null,
  quality: number | null,
) {
  return `${src}|${width ?? "auto"}|${height ?? "auto"}|${quality ?? "auto"}`;
}

function buildImageResponse(
  body: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
) {
  const bytes = new Uint8Array(body.byteLength);
  bytes.set(body);
  return new Response(bytes.buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      ...extraHeaders,
    },
  });
}

function getStaleFrameResponse(cacheKey: string, reason: string, upstreamStatus?: number) {
  const cached = staleFrameCache.get(cacheKey);
  if (!cached) return null;
  const ageMs = Date.now() - cached.createdAt;
  if (ageMs > STALE_FRAME_MAX_AGE_MS) {
    staleFrameCache.delete(cacheKey);
    return null;
  }
  return buildImageResponse(cached.body, cached.contentType, {
    "X-Camera-Stale": "1",
    "X-Camera-Stale-Age-Ms": String(ageMs),
    "X-Camera-Stale-Reason": reason,
    ...(upstreamStatus ? { "X-Camera-Upstream-Status": String(upstreamStatus) } : {}),
  });
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src") || "";
  if (!src || !isValidSrc(src)) {
    return new Response("invalid src", { status: 400 });
  }

  const go2rtcBaseUrl = process.env.GO2RTC_BASE_URL || DEFAULT_GO2RTC_BASE_URL;
  const width = parseIntParam(
    req.nextUrl.searchParams.get("width") ?? process.env.GO2RTC_FRAME_WIDTH,
    160,
    7680,
  );
  const height = parseIntParam(
    req.nextUrl.searchParams.get("height") ?? process.env.GO2RTC_FRAME_HEIGHT,
    120,
    4320,
  );
  const quality = parseIntParam(
    req.nextUrl.searchParams.get("quality") ?? process.env.GO2RTC_FRAME_QUALITY,
    1,
    100,
  );
  const timeoutMs = parseIntParam(
    req.nextUrl.searchParams.get("timeoutMs") ?? process.env.GO2RTC_FRAME_TIMEOUT_MS,
    300,
    15000,
  );
  const cacheKey = buildCacheKey(src, width, height, quality);

  const upstreamUrl = new URL(go2rtcBaseUrl);
  upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, "")}/api/frame.jpeg`;
  upstreamUrl.searchParams.set("src", src);
  if (width != null) upstreamUrl.searchParams.set("width", String(width));
  if (height != null) upstreamUrl.searchParams.set("height", String(height));
  if (quality != null) upstreamUrl.searchParams.set("quality", String(quality));

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs ?? 3500);
    const upstream = await fetch(upstreamUrl.toString(), {
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(t);
    });
    if (!upstream.ok) {
      const stale = getStaleFrameResponse(cacheKey, "upstream_status", upstream.status);
      if (stale) return stale;
      const reason = await upstream.text().catch(() => "");
      return new Response(
        `go2rtc upstream status=${upstream.status} src=${src} body=${reason.slice(0, 300)}`,
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    staleFrameCache.set(cacheKey, {
      body,
      contentType,
      createdAt: Date.now(),
    });
    return buildImageResponse(body, contentType);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const stale = getStaleFrameResponse(cacheKey, "upstream_timeout");
      if (stale) return stale;
      return new Response(`camera frame timeout src=${src}`, { status: 504 });
    }
    console.error("[camera-frame] proxy error:", error);
    const stale = getStaleFrameResponse(cacheKey, "proxy_error");
    if (stale) return stale;
    return new Response("camera frame proxy error", { status: 500 });
  }
}
