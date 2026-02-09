"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import type { CameraConfig } from "@/lib/cameras";

const { Text } = Typography;

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
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1600);
  const response = await fetch(`/api/camera/frame?src=${encodeURIComponent(src)}&t=${Date.now()}`, {
    cache: "no-store",
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeout));
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
    // Mild enhancement to avoid over-amplifying noise/false positives.
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

function filterAndDedupeDetections(detections: any[], frameWidth: number, frameHeight: number) {
  const minSidePx = Math.max(26, Math.floor(Math.min(frameWidth, frameHeight) * 0.04));
  const minArea = frameWidth * frameHeight * 0.003;
  const maxArea = frameWidth * frameHeight * 0.65;
  const minScore = 0.22;

  const filtered = detections.filter((det) => {
    const box = getDetBox(det);
    if (!box) return false;
    const score = getDetScore(det);
    const area = box.width * box.height;
    const ratio = box.width / Math.max(1, box.height);
    const plausibleShape = ratio >= 0.72 && ratio <= 1.45;
    const plausibleSize =
      box.width >= minSidePx &&
      box.height >= minSidePx &&
      area >= minArea &&
      area <= maxArea;
    const maxSide = Math.max(box.width, box.height);
    const strongEnoughForSmallFace = maxSide >= 64 || score >= 0.45;
    return score >= minScore && plausibleShape && plausibleSize && strongEnoughForSmallFace;
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

export default function CameraTile({ camera }: { camera: CameraConfig }) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [faceFound, setFaceFound] = useState(false);
  const [faceCount, setFaceCount] = useState(0);
  const [detectStatus, setDetectStatus] = useState("detection idle");
  const lastPixelRef = useRef<string | null>(null);
  const lastServerLogRef = useRef(0);
  const stablePositiveFramesRef = useRef(0);

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
        await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
        setDetectStatus("detection active");
      } catch (error) {
        console.error("[camera] failed to load face models:", error);
        setDetectStatus("model load error");
        return;
      }

      // Fast pass each cycle + periodic quality pass keeps latency low.
      const tinyFastOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.32,
      });
      const tinyQualityOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 640,
        scoreThreshold: 0.2,
      });
      let loopCounter = 0;

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

          loopCounter += 1;
          let detections = await faceapi.detectAllFaces(captureCanvas, tinyFastOptions);
          if (!detections.length && loopCounter % 4 === 0) {
            detections = await faceapi.detectAllFaces(captureCanvas, tinyQualityOptions);
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

          if (count > 0) {
            stablePositiveFramesRef.current += 1;
          } else {
            stablePositiveFramesRef.current = 0;
          }
          const requiredFrames = maxSide >= 110 && maxScore >= 0.55 ? 1 : 2;
          const confirmedCount = stablePositiveFramesRef.current >= requiredFrames ? count : 0;
          setFaceCount(confirmedCount);
          setFaceFound(confirmedCount > 0);
          if (count === 0) {
            setDetectStatus(`searching (${frameInfo})`);
          } else {
            setDetectStatus(
              confirmedCount > 0
                ? `face detected (${frameInfo})`
                : `candidate detected (${frameInfo}, ${stablePositiveFramesRef.current}/${requiredFrames})`,
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
  }, [status]);

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
              {faceFound ? `Face found: ${faceCount}` : `No faces: ${faceCount}`} - {detectStatus}
            </Text>
          </div>
        </div>
        <Tag color={faceFound ? "green" : "geekblue"}>{faceFound ? "Face Found" : "RTSP"}</Tag>
      </div>
    </Card>
  );
}
