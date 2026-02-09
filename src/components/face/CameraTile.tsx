"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import type { CameraConfig } from "@/lib/cameras";

const { Text } = Typography;
const DEFAULT_DETECTION_MODE: "browser" | "worker" =
  process.env.NEXT_PUBLIC_DETECTION_MODE === "worker" ? "worker" : "browser";

async function waitForPlayer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const loadPlayer = (window as any).loadPlayer;
    if (typeof loadPlayer === "function") return loadPlayer;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function waitForFaceApi(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const faceapi = (window as any).faceapi;
    if (faceapi) return faceapi;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function drawSnapshotToCanvas(src: string, canvas: HTMLCanvasElement) {
  const response = await fetch(`/api/camera/frame?src=${encodeURIComponent(src)}&t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`snapshot_http_${response.status}`);
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no_capture_context");
    // Mild enhancement. Strong filters create phantom faces on textured backgrounds.
    ctx.filter = "brightness(1.06) contrast(1.08) saturate(1.03)";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";
  } finally {
    bitmap.close();
  }
}

function getDetBox(det: any) {
  const box = det?.box || det?.detection?.box;
  if (!box) return null;
  return {
    x: Number(box.x ?? 0),
    y: Number(box.y ?? 0),
    width: Number(box.width ?? 0),
    height: Number(box.height ?? 0),
  };
}

function getDetScore(det: any) {
  const score = det?.score ?? det?.detection?.score;
  return Number.isFinite(score) ? Number(score) : 0;
}

function iou(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function computeLumaBuffer(data: Uint8ClampedArray) {
  const luma = new Uint8Array(Math.floor(data.length / 4));
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Perceived luminance approximation (BT.601) in integer math.
    luma[j++] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
  }
  return luma;
}

function computeMotionScore(prev: Uint8Array | null, next: Uint8Array) {
  if (!prev || prev.length !== next.length) return 0;
  let sum = 0;
  for (let i = 0; i < next.length; i += 1) {
    sum += Math.abs(next[i] - prev[i]);
  }
  return sum / next.length;
}

function filterAndDedupeDetections(detections: any[], frameWidth: number, frameHeight: number) {
  const minSidePx = Math.max(26, Math.floor(Math.min(frameWidth, frameHeight) * 0.04));
  const minArea = frameWidth * frameHeight * 0.0024;
  const maxArea = frameWidth * frameHeight * 0.65;
  const minScore = 0.28;

  const filtered = detections.filter((det) => {
    const box = getDetBox(det);
    if (!box) return false;
    const score = getDetScore(det);
    const area = box.width * box.height;
    const ratio = box.width / Math.max(1, box.height);
    const plausibleShape = ratio >= 0.72 && ratio <= 1.42;
    const plausibleSize =
      box.width >= minSidePx &&
      box.height >= minSidePx &&
      area >= minArea &&
      area <= maxArea;
    const notNearEdge =
      box.x >= Math.max(2, Math.floor(frameWidth * 0.005)) &&
      box.y >= Math.max(2, Math.floor(frameHeight * 0.005)) &&
      box.x + box.width <= frameWidth - Math.max(2, Math.floor(frameWidth * 0.005)) &&
      box.y + box.height <= frameHeight - Math.max(2, Math.floor(frameHeight * 0.005));
    return score >= minScore && plausibleShape && plausibleSize && notNearEdge;
  });

  filtered.sort((a, b) => getDetScore(b) - getDetScore(a));
  const deduped: any[] = [];
  for (const det of filtered) {
    const box = getDetBox(det);
    if (!box) continue;
    const overlaps = deduped.some((kept) => {
      const keptBox = getDetBox(kept);
      return keptBox ? iou(box, keptBox) > 0.45 : false;
    });
    if (!overlaps) deduped.push(det);
  }
  return deduped;
}

function getLargestFaceStats(detections: any[]) {
  let maxSide = 0;
  let maxScore = 0;
  for (const det of detections) {
    const box = getDetBox(det);
    if (!box) continue;
    const side = Math.max(box.width, box.height);
    if (side > maxSide) maxSide = side;
    const score = getDetScore(det);
    if (score > maxScore) maxScore = score;
  }
  return { maxSide, maxScore };
}

export default function CameraTile({
  camera,
  detectionMode = DEFAULT_DETECTION_MODE,
}: {
  camera: CameraConfig;
  detectionMode?: "browser" | "worker";
}) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [faceFound, setFaceFound] = useState(false);
  const [faceCount, setFaceCount] = useState(0);
  const [confirmedFaceCount, setConfirmedFaceCount] = useState(0);
  const [detectStatus, setDetectStatus] = useState("detection idle");
  const lastPixelRef = useRef<string | null>(null);
  const lastServerLogRef = useRef(0);
  const stablePositiveFramesRef = useRef(0);
  const lastBestBoxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const lastConfirmedAtRef = useRef(0);
  const motionLumaRef = useRef<Uint8Array | null>(null);
  const frameSeqRef = useRef(0);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    ctx?.clearRect(0, 0, overlay.width, overlay.height);
    stablePositiveFramesRef.current = 0;
    lastBestBoxRef.current = null;
    lastConfirmedAtRef.current = 0;
    motionLumaRef.current = null;
    setFaceFound(false);
    setFaceCount(0);
    setConfirmedFaceCount(0);
    setDetectStatus(detectionMode === "worker" ? "worker waiting status" : "detection idle");
  }, [detectionMode]);

  useEffect(() => {
    let mounted = true;

    async function startStream() {
      const canvas = streamRef.current;
      if (!canvas) return;

      try {
        const loadPlayer = (await waitForPlayer()) as
          | ((options: { url: string; canvas: HTMLCanvasElement; audio?: boolean }) => Promise<any>)
          | null;
        if (!loadPlayer) throw new Error("rtsp_player_missing");

        const wsProto = location.protocol === "https:" ? "wss://" : "ws://";
        const url =
          `${wsProto}${location.host}/api/stream?url=${encodeURIComponent(camera.rtspUrl)}` +
          `&client=${encodeURIComponent(`${camera.id}-${Date.now()}`)}`;

        await loadPlayer({ url, canvas, audio: false });
        if (mounted) setStatus("ready");
      } catch (error) {
        console.error("[camera] stream error:", error);
        if (mounted) setStatus("error");
      }
    }

    void startStream();
    return () => {
      mounted = false;
    };
  }, [camera.id, camera.rtspUrl]);

  useEffect(() => {
    if (status !== "ready" || detectionMode !== "worker") return;

    let mounted = true;
    let timer = 0;

    const poll = async () => {
      if (!mounted) return;
      try {
        const res = await fetch(`/api/worker/status?cameraId=${encodeURIComponent(camera.id)}`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as {
          ts?: string;
          cameraId?: string;
          status?: {
            candidate?: number;
            confirmed?: number;
            score?: number;
            motion?: number;
            streak?: number;
            requiredFrames?: number;
          } | null;
        };

        const ws = payload.status;
        if (ws) {
          const candidate = Number(ws.candidate ?? 0);
          const confirmed = Number(ws.confirmed ?? 0);
          const score = Number(ws.score ?? 0);
          const motion = Number(ws.motion ?? 0);
          const streak = Number(ws.streak ?? 0);
          const required = Number(ws.requiredFrames ?? 0);
          const ageSec =
            payload.ts && Number.isFinite(Date.parse(payload.ts))
              ? Math.max(0, (Date.now() - Date.parse(payload.ts)) / 1000)
              : null;

          setFaceCount(candidate);
          setConfirmedFaceCount(confirmed);
          setFaceFound(confirmed > 0);
          setDetectStatus(
            `worker candidate=${candidate} confirmed=${confirmed} score=${score.toFixed(2)} motion=${motion.toFixed(1)} streak=${streak}/${required}` +
              (ageSec !== null ? ` age=${ageSec.toFixed(1)}s` : ""),
          );
        } else {
          setFaceCount(0);
          setConfirmedFaceCount(0);
          setFaceFound(false);
          setDetectStatus("worker waiting status");
        }
      } catch {
        setDetectStatus("worker status unavailable");
      }

      timer = window.setTimeout(() => {
        void poll();
      }, 700);
    };

    void poll();
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [status, camera.id, detectionMode]);

  useEffect(() => {
    if (detectionMode === "worker") return;

    let mounted = true;
    let timer = 0;
    let lastLoggedAt = 0;

    async function startDetection() {
      const streamCanvas = streamRef.current;
      const captureCanvas = captureRef.current;
      const overlayCanvas = overlayRef.current;
      if (!streamCanvas || !captureCanvas || !overlayCanvas) return;

      const faceapi = await waitForFaceApi();
      if (!faceapi) {
        console.warn("[camera] faceapi not loaded");
        setDetectStatus("faceapi unavailable");
        return;
      }

      try {
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
          faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
        ]);
        setDetectStatus("detection active");
      } catch (error) {
        console.error("[camera] failed to load face models:", error);
        setDetectStatus("model load error");
        return;
      }

      const ssdOptions = new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.52,
        maxResults: 12,
      });
      const tinyOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 608,
        scoreThreshold: 0.24,
      });
      const motionCanvas = document.createElement("canvas");
      motionCanvas.width = 96;
      motionCanvas.height = 54;
      const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });

      const loop = async () => {
        if (!mounted) return;

        try {
          if (camera.go2rtcSrc) {
            await drawSnapshotToCanvas(camera.go2rtcSrc, captureCanvas);
          } else {
            if (streamCanvas.width === 0 || streamCanvas.height === 0) {
              setDetectStatus("no frames");
              throw new Error("empty_frame");
            }
            captureCanvas.width = streamCanvas.width;
            captureCanvas.height = streamCanvas.height;
            const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
            if (!captureCtx) {
              setDetectStatus("no frame context");
              throw new Error("no_capture_context");
            }
            captureCtx.filter = "brightness(1.06) contrast(1.08) saturate(1.03)";
            captureCtx.drawImage(streamCanvas, 0, 0, captureCanvas.width, captureCanvas.height);
            captureCtx.filter = "none";
          }

          const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
          if (!captureCtx) {
            setDetectStatus("no frame context");
            throw new Error("no_capture_context");
          }

          try {
            const pixel = captureCtx.getImageData(0, 0, 1, 1).data;
            const key = `${pixel[0]}-${pixel[1]}-${pixel[2]}-${pixel[3]}`;
            if (lastPixelRef.current && lastPixelRef.current !== key) {
              setDetectStatus("frame updates");
            } else if (!lastPixelRef.current) {
              setDetectStatus("first frame");
            } else {
              setDetectStatus("frame stable");
            }
            lastPixelRef.current = key;
          } catch {
            setDetectStatus("frame read failed");
          }

          frameSeqRef.current += 1;
          let detections = await faceapi.detectAllFaces(captureCanvas, tinyOptions);
          // SSD is slower; run it periodically only when tiny sees nothing.
          if (!detections.length && frameSeqRef.current % 3 === 0) {
            detections = await faceapi.detectAllFaces(captureCanvas, ssdOptions);
          }
          const cleanedDetections = Array.isArray(detections)
            ? filterAndDedupeDetections(detections, captureCanvas.width, captureCanvas.height)
            : [];
          const count = cleanedDetections.length;
          const { maxSide, maxScore } = getLargestFaceStats(cleanedDetections);
          const frameInfo = `${captureCanvas.width}x${captureCanvas.height}`;

          const overlayWidth = streamCanvas.width || captureCanvas.width;
          const overlayHeight = streamCanvas.height || captureCanvas.height;
          overlayCanvas.width = overlayWidth;
          overlayCanvas.height = overlayHeight;
          const overlayCtx = overlayCanvas.getContext("2d");
          overlayCtx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

          const resized = faceapi.resizeResults(cleanedDetections, {
            width: overlayCanvas.width,
            height: overlayCanvas.height,
          });
          faceapi.draw.drawDetections(overlayCanvas, resized);
          let motionScore = 0;
          if (motionCtx) {
            motionCtx.drawImage(captureCanvas, 0, 0, motionCanvas.width, motionCanvas.height);
            const motionPixels = motionCtx.getImageData(
              0,
              0,
              motionCanvas.width,
              motionCanvas.height,
            ).data;
            const nextLuma = computeLumaBuffer(motionPixels);
            motionScore = computeMotionScore(motionLumaRef.current, nextLuma);
            motionLumaRef.current = nextLuma;
          }

          const bestCurrentBox =
            count > 0
              ? getDetBox(
                  cleanedDetections.reduce((best, curr) =>
                    getDetScore(curr) > getDetScore(best) ? curr : best,
                  )
                )
              : null;
          const trackStable =
            bestCurrentBox && lastBestBoxRef.current
              ? iou(bestCurrentBox, lastBestBoxRef.current) >= 0.08
              : false;
          lastBestBoxRef.current = bestCurrentBox;

          if (count > 0 && maxScore >= 0.3 && (trackStable || stablePositiveFramesRef.current === 0)) {
            stablePositiveFramesRef.current += 1;
          } else if (count > 0 && maxScore >= 0.3) {
            stablePositiveFramesRef.current = 1;
          } else {
            stablePositiveFramesRef.current = 0;
          }

          const requiredFrames = maxSide >= 140 ? 1 : maxSide >= 95 ? 2 : 3;
          const minConfirmScore = maxSide >= 140 ? 0.34 : maxSide >= 95 ? 0.38 : 0.46;
          const recentConfirmed = Date.now() - lastConfirmedAtRef.current < 1800;
          const hasMotion = motionScore >= 1.5;
          const motionGate = hasMotion || recentConfirmed || maxScore >= 0.65 || maxSide >= 150;
          const confirmedCount =
            stablePositiveFramesRef.current >= requiredFrames &&
            maxScore >= minConfirmScore &&
            motionGate
              ? count
              : 0;
          if (confirmedCount > 0) {
            lastConfirmedAtRef.current = Date.now();
          }
          setFaceCount(count);
          setConfirmedFaceCount(confirmedCount);
          setFaceFound(confirmedCount > 0);
          if (count === 0) {
            setDetectStatus(`searching (${frameInfo})`);
          } else {
            setDetectStatus(
              confirmedCount > 0
                ? `face detected (${frameInfo})`
                : `candidate (${frameInfo}, score=${maxScore.toFixed(2)}, motion=${motionScore.toFixed(1)}, c=${count}, ${stablePositiveFramesRef.current}/${requiredFrames})`,
            );
          }

          const now = Date.now();
          if (confirmedCount > 0 && now - lastLoggedAt > 1500) {
            console.log(`[camera] face_found count=${confirmedCount}`);
            lastLoggedAt = now;
          }

          if (confirmedCount > 0 && now - lastServerLogRef.current > 1000) {
            lastServerLogRef.current = now;
            void fetch("/api/detections/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                cameraId: camera.id,
                cameraName: camera.name,
                faces: confirmedCount,
                status: "face_detected",
                ts: new Date().toISOString(),
              }),
            }).catch(() => {
              // Ignore transient network issues for non-critical logging.
            });
          }
        } catch (error) {
          if (camera.go2rtcSrc) {
            setDetectStatus("snapshot unavailable");
          }
          console.error("[camera] detection error:", error);
        }

        timer = window.setTimeout(() => {
          void loop();
        }, 120);
      };

      void loop();
    }

    if (status === "ready") {
      void startDetection();
    }

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [status, detectionMode]);

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        <canvas ref={streamRef} className="camera-video" />
        <canvas ref={captureRef} style={{ display: "none" }} />
        <canvas ref={overlayRef} className="camera-overlay" />
        {status !== "ready" ? (
          <div className="camera-status">
            <VideoCameraOutlined /> {status === "error" ? "Error" : "Loading"}
          </div>
        ) : null}
      </div>
      <div className="camera-footer">
        <div>
          <Text strong>{camera.name}</Text>
          <div>
            <Text type="secondary">{camera.location || camera.id}</Text>
          </div>
          <div>
            <Text type="secondary">
              {faceFound
                ? `Faces: ${faceCount} (confirmed: ${confirmedFaceCount})`
                : `Faces: ${faceCount} (confirmed: 0)`}{" "}
              - {detectStatus}
            </Text>
          </div>
        </div>
        <Tag color={faceFound ? "green" : "geekblue"}>{faceFound ? "Face Found" : "RTSP"}</Tag>
      </div>
    </Card>
  );
}
