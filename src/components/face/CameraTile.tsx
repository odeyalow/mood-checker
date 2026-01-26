"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Space, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import {
  ensureFaceApiReady,
  ensureRtspPlayerReady,
  getFaceMatcher,
  isRecognitionReady,
} from "./faceApi";

const { Text } = Typography;

type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl?: string;
  type?: "rtsp" | "webcam";
};

const MOOD_LABELS: Record<string, string> = {
  neutral: "Нейтральный",
  happy: "Счастливый",
  sad: "Грустный",
  angry: "Злой",
  fearful: "Испуганный",
  disgusted: "Отвращение",
  surprised: "Удивлен",
};

function bestExpression(expressions: Record<string, number>) {
  let bestKey = "neutral";
  let bestVal = 0;
  for (const [key, value] of Object.entries(expressions)) {
    if (value > bestVal) {
      bestVal = value;
      bestKey = key;
    }
  }
  if (!MOOD_LABELS[bestKey]) bestKey = "neutral";
  return bestKey;
}

function moodTagColor(label: string) {
  switch (label) {
    case "Злой":
      return "red";
    case "Грустный":
      return "geekblue";
    case "Испуганный":
      return "volcano";
    case "Отвращение":
      return "magenta";
    case "Удивлен":
      return "gold";
    case "Счастливый":
      return "green";
    default:
      return "blue";
  }
}

export default function CameraTile({ camera }: { camera: CameraConfig }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<any>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState("loading");
  const [fps, setFps] = useState(0);
  const [detected, setDetected] = useState<{ name: string; mood: string }[]>(
    []
  );

  const isRtsp = camera.type !== "webcam" && Boolean(camera.rtspUrl);

  const statusTag = useMemo(() => {
    if (status === "ready") return <Badge status="success" text="Онлайн" />;
    if (status === "error") return <Badge status="error" text="Ошибка" />;
    return <Badge status="processing" text="Загрузка" />;
  }, [status]);

  useEffect(() => {
    let active = true;
    let loopTimer: number | null = null;
    let lastTs = performance.now();
    let frames = 0;

    const cleanup = () => {
      if (loopTimer) window.clearTimeout(loopTimer);
      if (playerRef.current?.destroy) playerRef.current.destroy();
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((track) => track.stop());
        webcamStreamRef.current = null;
      }
    };

    const syncOverlaySize = (source: HTMLVideoElement | HTMLCanvasElement) => {
      const canvas = overlayRef.current;
      if (!canvas) return false;
      const width =
        source instanceof HTMLVideoElement
          ? source.videoWidth
          : source.width || source.clientWidth;
      const height =
        source instanceof HTMLVideoElement
          ? source.videoHeight
          : source.height || source.clientHeight;
      if (!width || !height) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      return true;
    };

    const getDetectionSource = (
      source: HTMLVideoElement | HTMLCanvasElement
    ) => {
      if (source instanceof HTMLVideoElement) return source;
      if (!source.width || !source.height) return null;
      return source;
    };

    const startWebcam = async () => {
      const video = videoRef.current;
      if (!video) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      webcamStreamRef.current = stream;
      video.srcObject = stream;
      await new Promise((resolve) => {
        video.onloadedmetadata = () => resolve(null);
      });
      await video.play();
    };

    const startRtsp = async () => {
      const streamCanvas = streamRef.current;
      if (!streamCanvas || !camera.rtspUrl) return;
      await ensureRtspPlayerReady();
      const wsProto = location.protocol === "https:" ? "wss://" : "ws://";
      const wsUrl = `${wsProto}${location.host}/api/stream?url=${encodeURIComponent(
        camera.rtspUrl
      )}`;
      playerRef.current = await (window as any).loadPlayer({
        url: wsUrl,
        canvas: streamCanvas,
        audio: false,
        disableGl: true,
      });
    };

    const loop = async () => {
      if (!active) return;
      const faceapi = (window as any).faceapi;
      const overlay = overlayRef.current;
      const video = videoRef.current;
      const streamCanvas = streamRef.current;
      if (!faceapi || !overlay || !video || !streamCanvas) {
        loopTimer = window.setTimeout(loop, 300);
        return;
      }

      const source = isRtsp ? streamCanvas : video;
      if (!syncOverlaySize(source)) {
        loopTimer = window.setTimeout(loop, 200);
        return;
      }

      const detectionSource = getDetectionSource(source);
      if (!detectionSource) {
        loopTimer = window.setTimeout(loop, 200);
        return;
      }

      frames += 1;
      const now = performance.now();
      if (now - lastTs >= 1000) {
        if (active) setFps(frames);
        frames = 0;
        lastTs = now;
      }

      const faceMatcher = await getFaceMatcher();
      let detection = faceapi.detectAllFaces(
        detectionSource,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.4,
        })
      );
      if (isRecognitionReady()) {
        detection = detection.withFaceLandmarks().withFaceDescriptors();
      }
      const results = await detection.withFaceExpressions();

      const ctx = overlay.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);

      if (results && results.length > 0) {
        const resized = faceapi.resizeResults(results, {
          width: overlay.width,
          height: overlay.height,
        });
        faceapi.draw.drawDetections(overlay, resized);

        const people = new Map<string, string>();
        for (const result of results) {
          const moodKey = result.expressions ? bestExpression(result.expressions) : "neutral";
          let label = "Unknown";
          if (faceMatcher && result.descriptor) {
            const match = faceMatcher.findBestMatch(result.descriptor);
            if (match.label && match.label !== "unknown") {
              label = match.label;
            }
          }
          people.set(label, MOOD_LABELS[moodKey] || moodKey);
        }
        if (active) {
          setDetected(
            Array.from(people.entries()).map(([name, mood]) => ({ name, mood }))
          );
        }
      } else if (active) {
        setDetected([]);
      }

      loopTimer = window.setTimeout(loop, 140);
    };

    const init = async () => {
      try {
        setStatus("loading");
        await ensureFaceApiReady();
        if (isRtsp) {
          if (videoRef.current) videoRef.current.style.display = "none";
          if (streamRef.current) streamRef.current.style.display = "block";
          await startRtsp();
        } else {
          if (videoRef.current) videoRef.current.style.display = "block";
          if (streamRef.current) streamRef.current.style.display = "none";
          await startWebcam();
        }
        if (active) {
          setStatus("ready");
          loop();
        }
      } catch (_err) {
        if (active) setStatus("error");
      }
    };

    init();
    return () => {
      active = false;
      cleanup();
    };
  }, [camera.rtspUrl, camera.type, isRtsp]);

  return (
    <Card className="camera-card" size="small">
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        <div className="camera-media">
          <video ref={videoRef} className="camera-video" muted playsInline />
          <canvas ref={streamRef} className="camera-video" />
          <canvas ref={overlayRef} className="camera-overlay" />
          {status !== "ready" && (
            <div className="camera-status">
              <VideoCameraOutlined /> {status === "error" ? "Ошибка" : "Загрузка"}
            </div>
          )}
        </div>
        <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
          <div>
            <Text strong>{camera.name}</Text>
            <div>
              <Text type="secondary">{camera.location || camera.id}</Text>
            </div>
          </div>
          {statusTag}
        </Space>
        <Space wrap>
          <Tag color="blue">FPS: {fps}</Tag>
          <Tag color={isRtsp ? "geekblue" : "gold"}>
            {isRtsp ? "RTSP" : "Webcam"}
          </Tag>
        </Space>
        <div>
          <Text type="secondary">Распознавание</Text>
          {detected.length === 0 ? (
            <div className="camera-empty">Никого нет</div>
          ) : (
            <div className="camera-people">
              {detected.map((item) => (
                <div key={`${camera.id}-${item.name}`} className="camera-person">
                  <Text strong>{item.name}</Text>
                  <Tag color={moodTagColor(item.mood)}>
                    {item.mood}
                  </Tag>
                </div>
              ))}
            </div>
          )}
        </div>
      </Space>
    </Card>
  );
}

