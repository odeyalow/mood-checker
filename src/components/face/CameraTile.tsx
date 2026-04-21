"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import type { CameraConfig } from "@/lib/cameras";

const { Text } = Typography;
const MIN_ZOOM = 1;
const WORKER_ZOOM_PRESETS = [1, 2, 3, 4, 5];
const MJPEG_RETRY_DELAY_MS = 1500;
const MJPEG_LOAD_TIMEOUT_MS = 5000;
const MJPEG_MAX_RECOVERY_ATTEMPTS = 2;

type PreviewMode = "mjpeg-direct" | "mjpeg-proxy" | "frame";

function parseClientEnvInt(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parsePreviewMode(rawValue: string | undefined, fallback: PreviewMode): PreviewMode {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (normalized === "mjpeg" || normalized === "mjpeg-direct") return "mjpeg-direct";
  if (normalized === "mjpeg-proxy") return "mjpeg-proxy";
  if (normalized === "frame") return "frame";
  return fallback;
}

const DEFAULT_PREVIEW_MODE = parsePreviewMode(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_MODE,
  "mjpeg-direct",
);
const FRAME_REFRESH_DELAY_MS = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_REFRESH_MS,
  220,
  80,
  5000,
);
const FRAME_ERROR_RETRY_MS = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_ERROR_RETRY_MS,
  900,
  200,
  10000,
);
const FRAME_ERROR_MAX_RETRY_MS = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_MAX_RETRY_MS,
  4000,
  500,
  20000,
);
const PREVIEW_FRAME_WIDTH = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_WIDTH,
  480,
  160,
  1920,
);
const PREVIEW_FRAME_HEIGHT = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_HEIGHT,
  270,
  120,
  1080,
);
const PREVIEW_FRAME_QUALITY = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_QUALITY,
  75,
  1,
  100,
);
const PREVIEW_FRAME_TIMEOUT_MS = parseClientEnvInt(
  process.env.NEXT_PUBLIC_CAMERA_PREVIEW_TIMEOUT_MS,
  2600,
  300,
  15000,
);

type WorkerPerson = {
  name: string;
  emotion?: string;
  emotionConfidence?: number;
  distance?: number;
};

type WorkerStatus = {
  candidate?: number;
  confirmed?: number;
  personInFrame?: boolean;
  faceInFrame?: boolean;
  matchedNames?: string[];
  topEmotion?: string;
  lastRecognitionEmotion?: string;
  lastRecognitionMood?: string;
  people?: WorkerPerson[];
  previewUrl?: string;
  snapshotUrl?: string;
  lastRecognitionAt?: string;
  frameOk?: boolean;
  workerZoom?: number;
  workerOffsetY?: number;
  frameWidth?: number;
  frameHeight?: number;
};

type SnapshotHistoryItem = {
  id: string;
  snapshotUrl: string;
  who: string;
  emotion: string;
  capturedAt: string;
};

function clampWorkerZoom(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const clamped = Math.min(5, Math.max(1, value));
  return Number(clamped.toFixed(1));
}

function clampFrameOffsetY(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Number(Math.min(0.35, Math.max(-0.35, value)).toFixed(3));
}

function formatRecognitionTime(raw: string) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleTimeString();
}

function namesFromStatus(status: WorkerStatus): string[] {
  if (Array.isArray(status.people)) {
    return status.people
      .map((person) => String(person?.name ?? "").trim())
      .filter((name) => name.length > 0);
  }
  if (Array.isArray(status.matchedNames)) {
    return status.matchedNames
      .map((name) => String(name ?? "").trim())
      .filter((name) => name.length > 0);
  }
  return [];
}

function emotionSummaryFromPeople(people: WorkerPerson[]): string {
  if (!Array.isArray(people) || !people.length) return "";
  return people
    .map((person) => {
      const name = String(person?.name ?? "").trim();
      if (!name) return "";
      const emotion = String(person?.emotion ?? "").trim() || "-";
      return `${name}: ${emotion}`;
    })
    .filter(Boolean)
    .join(", ");
}

function renderZoomedCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
  offsetY = 0,
) {
  const safeZoom = clampWorkerZoom(zoom);
  const safeOffsetY = clampFrameOffsetY(offsetY);
  const cropWidth =
    safeZoom > 1 ? Math.max(64, Math.floor(sourceWidth / safeZoom)) : sourceWidth;
  const cropHeight =
    safeZoom > 1 ? Math.max(64, Math.floor(sourceHeight / safeZoom)) : sourceHeight;
  const cropX = Math.max(0, Math.floor((sourceWidth - cropWidth) / 2));
  const cropYRange = Math.max(0, sourceHeight - cropHeight);
  const cropY = Math.max(
    0,
    Math.min(
      cropYRange,
      Math.floor(cropYRange / 2 - safeOffsetY * cropYRange),
    ),
  );

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("snapshot_context_unavailable");

  ctx.drawImage(
    source,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  return canvas;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("snapshot_blob_empty"));
      },
      "image/jpeg",
      quality,
    );
  });
}

function triggerDownload(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

function buildFrameApiPath(
  src: string,
  options?: {
    width?: number;
    height?: number;
    quality?: number;
    timeoutMs?: number;
  },
) {
  const params = new URLSearchParams();
  params.set("src", src);

  if (options?.width) params.set("width", String(options.width));
  if (options?.height) params.set("height", String(options.height));
  if (options?.quality) params.set("quality", String(options.quality));
  if (options?.timeoutMs) params.set("timeoutMs", String(options.timeoutMs));

  return `/api/camera/frame?${params.toString()}`;
}

function buildMjpegApiPath(src: string, token = 0) {
  const params = new URLSearchParams();
  params.set("src", src);
  params.set("v", String(token));
  return `/api/camera/mjpeg?${params.toString()}`;
}

function buildDirectMjpegUrl(baseUrl: string, src: string, token = 0) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/stream.mjpeg`;
  url.searchParams.set("src", src);
  url.searchParams.set("v", String(token));
  return url.toString();
}

function isMjpegPreviewMode(mode: PreviewMode) {
  return mode === "mjpeg-direct" || mode === "mjpeg-proxy";
}

export default function CameraTile({
  camera,
  labels,
}: {
  camera: CameraConfig;
  labels: {
    loading: string;
    error: string;
    recognized: string;
    noRecognitions: string;
    emotion: string;
    snapshotTitle: string;
    whoLabel: string;
    emotionLabel: string;
    unknownLabel: string;
    noneLabel: string;
    downloadFrame: string;
    downloadingFrame: string;
  };
}) {
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const lastSnapshotKeyRef = useRef("");
  const frameSizeRef = useRef({ width: 0, height: 0 });
  const mjpegRetryTimerRef = useRef<number | null>(null);
  const mjpegLoadTimeoutRef = useRef<number | null>(null);
  const frameRefreshTimerRef = useRef<number | null>(null);
  const previewHadSuccessRef = useRef(false);
  const frameFailureCountRef = useRef(0);
  const mjpegFailureCountRef = useRef(0);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewMode, setPreviewMode] = useState<PreviewMode>(DEFAULT_PREVIEW_MODE);
  const [previewToken, setPreviewToken] = useState(0);
  const [go2rtcPublicBaseUrl, setGo2rtcPublicBaseUrl] = useState("");
  const [people, setPeople] = useState<WorkerPerson[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState("");
  const [snapshotWho, setSnapshotWho] = useState("");
  const [snapshotEmotion, setSnapshotEmotion] = useState("");
  const [lastRecognitionAt, setLastRecognitionAt] = useState("");
  const [history, setHistory] = useState<SnapshotHistoryItem[]>([]);
  const [workerZoom, setWorkerZoom] = useState(1);
  const [workerOffsetY, setWorkerOffsetY] = useState(clampFrameOffsetY(camera.frameOffsetY));
  const [workerZoomSaving, setWorkerZoomSaving] = useState(false);
  const [frameDownloading, setFrameDownloading] = useState(false);

  const previewUrl = useMemo(() => {
    if (!camera.go2rtcSrc) return "";
    if (previewMode === "frame") {
      const params = new URLSearchParams();
      params.set("src", camera.go2rtcSrc);
      params.set("width", String(PREVIEW_FRAME_WIDTH));
      params.set("height", String(PREVIEW_FRAME_HEIGHT));
      params.set("quality", String(PREVIEW_FRAME_QUALITY));
      params.set("timeoutMs", String(PREVIEW_FRAME_TIMEOUT_MS));
      params.set("v", String(previewToken));
      return `/api/camera/frame?${params.toString()}`;
    }
    if (previewMode === "mjpeg-direct" && go2rtcPublicBaseUrl) {
      return buildDirectMjpegUrl(go2rtcPublicBaseUrl, camera.go2rtcSrc, previewToken);
    }
    return buildMjpegApiPath(camera.go2rtcSrc, previewToken);
  }, [camera.go2rtcSrc, go2rtcPublicBaseUrl, previewMode, previewToken]);

  useEffect(() => {
    const explicitBase = String(process.env.NEXT_PUBLIC_GO2RTC_BASE_URL || "").trim();
    if (explicitBase) {
      setGo2rtcPublicBaseUrl(explicitBase);
      return;
    }
    if (typeof window !== "undefined") {
      setGo2rtcPublicBaseUrl(`${window.location.protocol}//${window.location.hostname}:1984`);
    }
  }, []);

  useEffect(() => {
    setPeople([]);
    setSnapshotUrl("");
    setSnapshotWho("");
    setSnapshotEmotion("");
    setLastRecognitionAt("");
    setHistory([]);
    setWorkerZoom(clampWorkerZoom(camera.digitalZoom));
    setWorkerOffsetY(clampFrameOffsetY(camera.frameOffsetY));
    setPreviewMode(DEFAULT_PREVIEW_MODE);
    setPreviewToken(0);
    setStatus("loading");
    frameSizeRef.current = { width: 0, height: 0 };
    lastSnapshotKeyRef.current = "";
    previewHadSuccessRef.current = false;
    frameFailureCountRef.current = 0;
    mjpegFailureCountRef.current = 0;

    if (mjpegRetryTimerRef.current !== null) {
      window.clearTimeout(mjpegRetryTimerRef.current);
      mjpegRetryTimerRef.current = null;
    }
    if (mjpegLoadTimeoutRef.current !== null) {
      window.clearTimeout(mjpegLoadTimeoutRef.current);
      mjpegLoadTimeoutRef.current = null;
    }
    if (frameRefreshTimerRef.current !== null) {
      window.clearTimeout(frameRefreshTimerRef.current);
      frameRefreshTimerRef.current = null;
    }
  }, [camera.id]);

  useEffect(() => {
    return () => {
      if (mjpegRetryTimerRef.current !== null) {
        window.clearTimeout(mjpegRetryTimerRef.current);
        mjpegRetryTimerRef.current = null;
      }
      if (mjpegLoadTimeoutRef.current !== null) {
        window.clearTimeout(mjpegLoadTimeoutRef.current);
        mjpegLoadTimeoutRef.current = null;
      }
      if (frameRefreshTimerRef.current !== null) {
        window.clearTimeout(frameRefreshTimerRef.current);
        frameRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!previewUrl) return;
    if (mjpegLoadTimeoutRef.current !== null) {
      window.clearTimeout(mjpegLoadTimeoutRef.current);
    }
    const loadTimeoutMs =
      isMjpegPreviewMode(previewMode) ? MJPEG_LOAD_TIMEOUT_MS : PREVIEW_FRAME_TIMEOUT_MS + 500;
    mjpegLoadTimeoutRef.current = window.setTimeout(() => {
      mjpegLoadTimeoutRef.current = null;
      if (isMjpegPreviewMode(previewMode)) {
        handleMjpegPreviewFailure();
        return;
      }
      handleFramePreviewFailure();
    }, loadTimeoutMs);
  }, [previewMode, previewUrl]);

  useEffect(() => {
    let mounted = true;
    let timer = 0;

    const poll = async () => {
      if (!mounted) return;
      try {
        const res = await fetch(`/api/worker/status?cameraId=${encodeURIComponent(camera.id)}`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as { status?: WorkerStatus | null };
        const ws = payload.status;

        if (ws) {
          const names = namesFromStatus(ws);
          const who = names.join(", ");
          const zoom = clampWorkerZoom(Number(ws.workerZoom ?? 1));
          const offsetY = clampFrameOffsetY(Number(ws.workerOffsetY ?? camera.frameOffsetY ?? 0));

          setWorkerZoom(zoom);
          setWorkerOffsetY(offsetY);
          frameSizeRef.current = {
            width: Number.isFinite(Number(ws.frameWidth)) ? Number(ws.frameWidth) : 0,
            height: Number.isFinite(Number(ws.frameHeight)) ? Number(ws.frameHeight) : 0,
          };

          const nextPeople = Array.isArray(ws.people)
            ? ws.people
                .map((person) => ({
                  name: String(person?.name ?? "").trim(),
                  emotion: typeof person?.emotion === "string" ? person.emotion : "",
                  distance: Number.isFinite(person?.distance) ? Number(person.distance) : undefined,
                }))
                .filter((person) => person.name)
            : names.map((name) => ({ name, emotion: "" }));
          const emotion =
            emotionSummaryFromPeople(nextPeople) ||
            (typeof ws.lastRecognitionEmotion === "string" && ws.lastRecognitionEmotion.trim().length > 0
              ? ws.lastRecognitionEmotion.trim()
              : "") ||
            (typeof ws.topEmotion === "string" && ws.topEmotion.trim().length > 0
              ? ws.topEmotion.trim()
              : "") ||
            (typeof ws.lastRecognitionMood === "string" && ws.lastRecognitionMood.trim().length > 0
              ? ws.lastRecognitionMood.trim()
              : "");
          setPeople(nextPeople);

          const nextSnapshotUrl = typeof ws.snapshotUrl === "string" ? ws.snapshotUrl : "";
          const nextRecognitionAt =
            typeof ws.lastRecognitionAt === "string" ? ws.lastRecognitionAt : "";
          const nextWho = who || "";

          setSnapshotWho(nextWho);
          setSnapshotEmotion(emotion);
          setSnapshotUrl(nextSnapshotUrl);
          setLastRecognitionAt(nextRecognitionAt);

          if (nextSnapshotUrl && nextRecognitionAt) {
            const snapshotKey = `${nextSnapshotUrl}|${nextRecognitionAt}`;
            if (snapshotKey !== lastSnapshotKeyRef.current) {
              lastSnapshotKeyRef.current = snapshotKey;
              setHistory((prev) =>
                [
                  {
                    id: snapshotKey,
                    snapshotUrl: nextSnapshotUrl,
                    who: nextWho,
                    emotion,
                    capturedAt: nextRecognitionAt,
                  },
                  ...prev,
                ].slice(0, 5),
              );
            }
          }
        } else {
          setPeople([]);
          setSnapshotWho("");
          setSnapshotEmotion("");
          setLastRecognitionAt("");
        }
      } catch (error) {
        console.error("[camera] worker status error:", error);
      }

      timer = window.setTimeout(() => {
        void poll();
      }, 500);
    };

    void poll();
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [camera.frameOffsetY, camera.id]);

  async function setWorkerZoomRemote(nextZoom: number) {
    setWorkerZoomSaving(true);
    try {
      const res = await fetch("/api/worker/zoom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: camera.id, zoom: nextZoom }),
      });
      if (!res.ok) throw new Error(`zoom_http_${res.status}`);
      setWorkerZoom(clampWorkerZoom(nextZoom));
    } catch (error) {
      console.error("[camera] set worker zoom error:", error);
    } finally {
      setWorkerZoomSaving(false);
    }
  }

  async function fetchFrameBlobFromApi() {
    if (!camera.go2rtcSrc) return null;
    const frameWidth = frameSizeRef.current.width;
    const frameHeight = frameSizeRef.current.height;

    const res = await fetch(
      buildFrameApiPath(camera.go2rtcSrc, {
        width: frameWidth > 0 ? frameWidth : undefined,
        height: frameHeight > 0 ? frameHeight : undefined,
        quality: 92,
        timeoutMs: 4500,
      }),
      { cache: "no-store" },
    );
    if (!res.ok) {
      throw new Error(`frame_http_${res.status}`);
    }
    return res.blob();
  }

  async function downloadCurrentFrame() {
    setFrameDownloading(true);
    const zoom = clampWorkerZoom(workerZoom);
    const offsetY = clampFrameOffsetY(workerOffsetY);
    try {
      let exportCanvas: HTMLCanvasElement | null = null;

      try {
        const frameBlob = await fetchFrameBlobFromApi();
        if (frameBlob) {
          const bitmap = await createImageBitmap(frameBlob);
          try {
            exportCanvas = renderZoomedCanvas(bitmap, bitmap.width, bitmap.height, zoom, offsetY);
          } finally {
            bitmap.close();
          }
        }
      } catch (error) {
        console.error("[camera] frame api download fallback:", error);
      }

      if (!exportCanvas) {
        const previewImage = previewImageRef.current;
        const sourceWidth = Number(previewImage?.naturalWidth ?? 0);
        const sourceHeight = Number(previewImage?.naturalHeight ?? 0);
        if (!previewImage || !sourceWidth || !sourceHeight) {
          throw new Error("preview_image_unavailable");
        }
        exportCanvas = renderZoomedCanvas(previewImage, sourceWidth, sourceHeight, zoom, offsetY);
      }

      const blob = await canvasToJpegBlob(exportCanvas, 0.92);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      triggerDownload(blob, `${camera.id}-${stamp}-worker-z${zoom.toFixed(1)}x.jpg`);
    } catch (error) {
      console.error("[camera] download frame error:", error);
    } finally {
      setFrameDownloading(false);
    }
  }

  function scheduleMjpegReconnect() {
    if (mjpegRetryTimerRef.current !== null) return;
    mjpegRetryTimerRef.current = window.setTimeout(() => {
      mjpegRetryTimerRef.current = null;
      setStatus("loading");
      setPreviewToken((value) => value + 1);
    }, MJPEG_RETRY_DELAY_MS);
  }

  function scheduleFrameRefresh(delay = FRAME_REFRESH_DELAY_MS) {
    if (frameRefreshTimerRef.current !== null) return;
    frameRefreshTimerRef.current = window.setTimeout(() => {
      frameRefreshTimerRef.current = null;
      setPreviewToken((value) => value + 1);
    }, delay);
  }

  function fallbackFromMjpegMode() {
    if (previewMode === "mjpeg-direct") {
      setPreviewMode("mjpeg-proxy");
      setStatus("loading");
      mjpegFailureCountRef.current = 0;
      setPreviewToken((value) => value + 1);
      return;
    }
    setPreviewMode("frame");
    setStatus("loading");
    mjpegFailureCountRef.current = 0;
    setPreviewToken((value) => value + 1);
  }

  function handleMjpegPreviewFailure() {
    mjpegFailureCountRef.current += 1;

    const canRetryCurrentMjpeg =
      previewHadSuccessRef.current &&
      mjpegFailureCountRef.current <= MJPEG_MAX_RECOVERY_ATTEMPTS;
    if (canRetryCurrentMjpeg) {
      setStatus("loading");
      scheduleMjpegReconnect();
      return;
    }

    fallbackFromMjpegMode();
  }

  function handleFramePreviewFailure() {
    frameFailureCountRef.current += 1;
    const retryDelay = Math.min(
      FRAME_ERROR_MAX_RETRY_MS,
      FRAME_ERROR_RETRY_MS * frameFailureCountRef.current,
    );
    setStatus(previewHadSuccessRef.current ? "ready" : "error");
    scheduleFrameRefresh(retryDelay);
  }

  const effectivePreviewZoom = clampWorkerZoom(workerZoom || camera.digitalZoom);
  const effectivePreviewOffsetY = clampFrameOffsetY(workerOffsetY ?? camera.frameOffsetY);
  const previewTransform =
    effectivePreviewZoom > MIN_ZOOM || Math.abs(effectivePreviewOffsetY) > 0.001
      ? `translateY(${((effectivePreviewZoom - 1) * effectivePreviewOffsetY * 100).toFixed(2)}%) scale(${effectivePreviewZoom})`
      : "scale(1)";

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        {camera.go2rtcSrc ? (
          <img
            ref={previewImageRef}
            className="camera-video"
            src={previewUrl}
            alt={`${camera.name} preview`}
            onLoad={() => {
              if (mjpegLoadTimeoutRef.current !== null) {
                window.clearTimeout(mjpegLoadTimeoutRef.current);
                mjpegLoadTimeoutRef.current = null;
              }
              if (mjpegRetryTimerRef.current !== null) {
                window.clearTimeout(mjpegRetryTimerRef.current);
                mjpegRetryTimerRef.current = null;
              }
              previewHadSuccessRef.current = true;
              frameFailureCountRef.current = 0;
              mjpegFailureCountRef.current = 0;
              setStatus("ready");
              if (previewMode === "frame") {
                scheduleFrameRefresh();
              }
            }}
            onError={() => {
              if (mjpegLoadTimeoutRef.current !== null) {
                window.clearTimeout(mjpegLoadTimeoutRef.current);
                mjpegLoadTimeoutRef.current = null;
              }
              if (isMjpegPreviewMode(previewMode)) {
                handleMjpegPreviewFailure();
                return;
              }
              handleFramePreviewFailure();
            }}
            style={{
              transform: previewTransform,
              transformOrigin: "center center",
              transition: "transform 0.16s ease-out",
            }}
          />
        ) : null}
        {status !== "ready" ? (
          <div className="camera-status">
            <VideoCameraOutlined /> {status === "error" ? labels.error : labels.loading}
          </div>
        ) : null}
      </div>

      <div className="camera-footer">
        <div>
          <Text strong>{camera.name}</Text>
          <div>
            <Text type="secondary">{camera.location || camera.id}</Text>
          </div>
          <div className="camera-worker-zoom">
            <div className="camera-zoom-head">
              <Text type="secondary">Zoom (UI + worker)</Text>
              <Text type="secondary">{`x${effectivePreviewZoom.toFixed(1)} / y=${effectivePreviewOffsetY >= 0 ? "+" : ""}${effectivePreviewOffsetY.toFixed(2)}`}</Text>
            </div>
            <div className="camera-worker-zoom-buttons">
              {WORKER_ZOOM_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`camera-worker-zoom-button ${Math.abs(workerZoom - value) < 0.05 ? "active" : ""}`}
                  disabled={workerZoomSaving}
                  onClick={() => {
                    void setWorkerZoomRemote(value);
                  }}
                >
                  {value}x
                </button>
              ))}
            </div>
          </div>

          <div className="camera-actions">
            <button
              type="button"
              className="camera-action-button"
              disabled={frameDownloading}
              onClick={() => {
                void downloadCurrentFrame();
              }}
            >
              {frameDownloading ? labels.downloadingFrame : labels.downloadFrame}
            </button>
          </div>

          {people.length ? (
            <div className="camera-people">
              {people.map((person) => (
                <div key={`${person.name}-${person.emotion || "none"}`} className="camera-person">
                  <Text type="secondary">{person.name}</Text>
                  <Text type="secondary">{person.emotion ? person.emotion : labels.emotion}</Text>
                </div>
              ))}
            </div>
          ) : (
            <div className="camera-empty">
              <Text type="secondary">{labels.noRecognitions}</Text>
            </div>
          )}

          {snapshotUrl ? (
            <div className="camera-evidence">
              <img className="camera-evidence-image" src={snapshotUrl} alt={`${camera.name} snapshot`} />
              <div className="camera-evidence-meta">
                <Text type="secondary">{labels.snapshotTitle}</Text>
                {lastRecognitionAt ? (
                  <Text type="secondary">{formatRecognitionTime(lastRecognitionAt)}</Text>
                ) : null}
              </div>
              <div className="camera-evidence-meta">
                <Text type="secondary">{`${labels.whoLabel}: ${snapshotWho || labels.unknownLabel}`}</Text>
              </div>
              <div className="camera-evidence-meta">
                <Text type="secondary">{`${labels.emotionLabel}: ${snapshotEmotion || labels.noneLabel}`}</Text>
              </div>
            </div>
          ) : null}

          {history.length ? (
            <div className="camera-history">
              {history.map((item) => (
                <div key={item.id} className="camera-history-card">
                  <img className="camera-history-image" src={item.snapshotUrl} alt="history snapshot" />
                  <div className="camera-history-body">
                    <Text type="secondary">{`${labels.whoLabel}: ${item.who || labels.unknownLabel}`}</Text>
                    <Text type="secondary">{`${labels.emotionLabel}: ${item.emotion || labels.noneLabel}`}</Text>
                    <Text type="secondary">{formatRecognitionTime(item.capturedAt)}</Text>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <Tag color={people.length ? "green" : "geekblue"}>
          {people.length ? labels.recognized : "LIVE"}
        </Tag>
      </div>
    </Card>
  );
}
