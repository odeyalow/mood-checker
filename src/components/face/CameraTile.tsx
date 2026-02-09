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
        minConfidence: 0.28,
        maxResults: 10,
      });
      const tinyOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.16,
      });

      const loop = async () => {
        if (!mounted) return;

        try {
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

          captureCtx.drawImage(streamCanvas, 0, 0, captureCanvas.width, captureCanvas.height);

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

          // Try multiple detection paths because some RTSP renderers draw into canvas
          // in a way that one path may fail intermittently.
          let detections = await faceapi.detectAllFaces(streamCanvas, tinyOptions);
          if (!detections.length) {
            detections = await faceapi.detectAllFaces(captureCanvas, tinyOptions);
          }
          if (!detections.length) {
            detections = await faceapi.detectAllFaces(streamCanvas, ssdOptions);
          }
          if (!detections.length) {
            detections = await faceapi.detectAllFaces(captureCanvas, ssdOptions);
          }

          // Extra fallback for far faces: center crop + upscale.
          if (!detections.length) {
            const sw = captureCanvas.width;
            const sh = captureCanvas.height;
            const cw = Math.floor(sw * 0.6);
            const ch = Math.floor(sh * 0.6);
            const sx = Math.floor((sw - cw) / 2);
            const sy = Math.floor((sh - ch) / 2);
            const zoomCanvas = document.createElement("canvas");
            zoomCanvas.width = sw;
            zoomCanvas.height = sh;
            const zoomCtx = zoomCanvas.getContext("2d");
            if (zoomCtx) {
              zoomCtx.drawImage(captureCanvas, sx, sy, cw, ch, 0, 0, sw, sh);
              detections = await faceapi.detectAllFaces(zoomCanvas, tinyOptions);
            }
          }
          const count = Array.isArray(detections) ? detections.length : 0;

          overlayCanvas.width = streamCanvas.width;
          overlayCanvas.height = streamCanvas.height;
          const overlayCtx = overlayCanvas.getContext("2d");
          overlayCtx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

          const resized = faceapi.resizeResults(detections, {
            width: overlayCanvas.width,
            height: overlayCanvas.height,
          });
          faceapi.draw.drawDetections(overlayCanvas, resized);

          setFaceCount(count);
          setFaceFound(count > 0);

          const now = Date.now();
          if (count > 0 && now - lastLoggedAt > 2000) {
            console.log(`[camera] face_found count=${count}`);
            lastLoggedAt = now;
          }

          if (count > 0 && now - lastServerLogRef.current > 1000) {
            lastServerLogRef.current = now;
            void fetch("/api/detections/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                cameraId: camera.id,
                cameraName: camera.name,
                faces: count,
                status: "face_detected",
                ts: new Date().toISOString(),
              }),
            }).catch(() => {
              // Ignore transient network issues for non-critical logging.
            });
          }
        } catch (error) {
          console.error("[camera] detection error:", error);
        }

        timer = window.setTimeout(() => {
          void loop();
        }, 180);
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
