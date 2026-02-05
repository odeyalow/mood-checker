"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Space, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import { useSearchParams } from "next/navigation";
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

type CameraTileMode = "full" | "preview";
type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    online: "Онлайн",
    error: "Ошибка",
    loading: "Загрузка",
    preview: "Превью",
    recognition: "Распознавание",
    noPeople: "Никого нет",
  },
  kz: {
    online: "Онлайн",
    error: "Қате",
    loading: "Жүктеу",
    preview: "Алдын ала қарау",
    recognition: "Тану",
    noPeople: "Ешкім жоқ",
  },
  en: {
    online: "Online",
    error: "Error",
    loading: "Loading",
    preview: "Preview",
    recognition: "Recognition",
    noPeople: "No people",
  },
} as const;

type RecognitionPayload = {
  name: string;
  mood: string;
  detectedAt: string;
};

const PERSON_ABSENCE_GRACE_MS = 2_000;
const EMOTION_STABILITY_FRAMES = 3;
const EMOTION_CONFIDENCE_THRESHOLD = 0.48;
const DETECTION_SCORE_THRESHOLD = 0.45;
const DETECTION_INTERVAL_MS = 90;
const RECOGNITION_RESEND_MS = 15_000;

const MOOD_LABELS: Record<string, string> = {
  neutral: "Neutral",
  happy: "Happy",
  sad: "Sad",
  angry: "Angry",
  fearful: "Fearful",
  disgusted: "Disgusted",
  surprised: "Surprised",
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
  if (!MOOD_LABELS[bestKey] || bestVal < EMOTION_CONFIDENCE_THRESHOLD) bestKey = "neutral";
  return bestKey;
}

function moodTagColor(label: string) {
  switch (label) {
    case "Angry":
      return "red";
    case "Sad":
      return "geekblue";
    case "Fearful":
      return "volcano";
    case "Disgusted":
      return "magenta";
    case "Surprised":
      return "gold";
    case "Happy":
      return "green";
    default:
      return "blue";
  }
}

export default function CameraTile({
  camera,
  mode = "full",
  locale = "ru",
}: {
  camera: CameraConfig;
  mode?: CameraTileMode;
  locale?: AppLocale;
}) {
  const searchParams = useSearchParams();
  const t = L10N[locale];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<any>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const lastSentRef = useRef<Map<string, { mood: string; sentAt: number }>>(new Map());
  const stableMoodRef = useRef<Map<string, { mood: string; count: number }>>(new Map());
  const moodHistoryRef = useRef<Map<string, string[]>>(new Map());
  const detectBusyRef = useRef(false);
  const detectLastTsRef = useRef(0);

  const [status, setStatus] = useState("loading");
  const [fps, setFps] = useState(0);
  const [detected, setDetected] = useState<{ name: string; mood: string }[]>([]);

  const recognitionEnabled = mode === "full";
  const workerMode = searchParams.get("worker") === "1";
  const isRtsp = camera.type !== "webcam" && Boolean(camera.rtspUrl);

  const statusTag = useMemo(() => {
    if (status === "ready") return <Badge status="success" text={t.online} />;
    if (status === "error") return <Badge status="error" text={t.error} />;
    return <Badge status="processing" text={t.loading} />;
  }, [status, t.error, t.loading, t.online]);

  const rememberMood = (name: string, mood: string) => {
    const history = moodHistoryRef.current.get(name) ?? [];
    history.push(mood);
    if (history.length > EMOTION_STABILITY_FRAMES + 1) history.shift();
    moodHistoryRef.current.set(name, history);

    const counts = history.reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});

    let bestMood = mood;
    let bestCount = 0;
    for (const [key, value] of Object.entries(counts)) {
      if (value > bestCount) {
        bestMood = key;
        bestCount = value;
      }
    }
    return bestMood;
  };

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
      lastSeenRef.current.clear();
      lastSentRef.current.clear();
      stableMoodRef.current.clear();
      moodHistoryRef.current.clear();
    };

    const sendRecognition = async (payload: RecognitionPayload) => {
      try {
        await fetch("/api/recognitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        // ignore
      }
    };

    const syncOverlaySize = (source: HTMLVideoElement | HTMLCanvasElement) => {
      const canvas = overlayRef.current;
      if (!canvas) return false;
      const width =
        source instanceof HTMLVideoElement ? source.videoWidth : source.width || source.clientWidth;
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

    const getDetectionSource = (source: HTMLVideoElement | HTMLCanvasElement) => {
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
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (playerRef.current?.destroy) {
            playerRef.current.destroy();
            playerRef.current = null;
          }

          const wsUrl =
            `${wsProto}${location.host}/api/stream?url=${encodeURIComponent(camera.rtspUrl)}` +
            `&client=${encodeURIComponent(`${camera.id}-${Date.now()}-${attempt}`)}`;

          playerRef.current = await (window as any).loadPlayer({
            url: wsUrl,
            canvas: streamCanvas,
            audio: false,
            disableGl: true,
          });
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      }

      throw lastError ?? new Error("rtsp_player_failed");
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

      const nowTs = performance.now();
      if (detectBusyRef.current || nowTs - detectLastTsRef.current < DETECTION_INTERVAL_MS) {
        loopTimer = window.setTimeout(loop, 30);
        return;
      }
      detectBusyRef.current = true;
      detectLastTsRef.current = nowTs;

      frames += 1;
      if (nowTs - lastTs >= 1000) {
        if (active) setFps(frames);
        frames = 0;
        lastTs = nowTs;
      }

      let results: any[] = [];
      try {
        const faceMatcher = await getFaceMatcher();
        const detectorOptions = new faceapi.TinyFaceDetectorOptions({
          inputSize: isRtsp ? 320 : 416,
          scoreThreshold: DETECTION_SCORE_THRESHOLD,
        });
        let detection = faceapi.detectAllFaces(detectionSource, detectorOptions);
        if (isRecognitionReady()) {
          detection = detection.withFaceLandmarks(true).withFaceDescriptors();
        }
        results = (await detection.withFaceExpressions()).filter(
          (item: { detection?: { score?: number } }) =>
            (item.detection?.score ?? 0) >= DETECTION_SCORE_THRESHOLD
        );

        const ctx = overlay.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (results.length > 0) {
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

            const nextMood = rememberMood(label, MOOD_LABELS[moodKey] || moodKey);
            const stableState = stableMoodRef.current.get(label);
            if (!stableState || stableState.mood !== nextMood) {
              stableMoodRef.current.set(label, { mood: nextMood, count: 1 });
              people.set(label, nextMood);
              continue;
            }
            const nextCount = Math.min(stableState.count + 1, EMOTION_STABILITY_FRAMES);
            stableMoodRef.current.set(label, { mood: nextMood, count: nextCount });
            people.set(label, stableState.mood);
          }

          if (active) {
            setDetected(Array.from(people.entries()).map(([name, mood]) => ({ name, mood })));
          }

          const sendTs = Date.now();
          for (const [name, mood] of people.entries()) {
          if (name === "Unknown" && !workerMode) continue;
            const stableState = stableMoodRef.current.get(name);
            if (!stableState || stableState.count < EMOTION_STABILITY_FRAMES) continue;
            const lastSeenAt = lastSeenRef.current.get(name);
            const wasVisibleRecently =
              typeof lastSeenAt === "number" && sendTs - lastSeenAt <= PERSON_ABSENCE_GRACE_MS;
          const lastSent = lastSentRef.current.get(name);
          const moodChanged = lastSent ? lastSent.mood !== mood : true;
          const resendDue = lastSent ? sendTs - lastSent.sentAt >= RECOGNITION_RESEND_MS : true;
          if (wasVisibleRecently && !moodChanged && !resendDue) continue;

            lastSentRef.current.set(name, { mood, sentAt: sendTs });
            void sendRecognition({
              name,
              mood,
              detectedAt: new Date(sendTs).toISOString(),
            });
          }

          for (const name of people.keys()) {
            if (name !== "Unknown") lastSeenRef.current.set(name, sendTs);
          }

          for (const [name, seenAt] of lastSeenRef.current.entries()) {
            if (sendTs - seenAt > PERSON_ABSENCE_GRACE_MS) {
              lastSeenRef.current.delete(name);
              lastSentRef.current.delete(name);
              stableMoodRef.current.delete(name);
              moodHistoryRef.current.delete(name);
            }
          }
        } else if (active) {
          setDetected([]);
          const clearTs = Date.now();
          for (const [name, seenAt] of lastSeenRef.current.entries()) {
            if (clearTs - seenAt > PERSON_ABSENCE_GRACE_MS) {
              lastSeenRef.current.delete(name);
              lastSentRef.current.delete(name);
              stableMoodRef.current.delete(name);
              moodHistoryRef.current.delete(name);
            }
          }
        }
      } finally {
        detectBusyRef.current = false;
      }

      loopTimer = window.setTimeout(loop, 30);
    };

    const init = async () => {
      try {
        setStatus("loading");
        if (isRtsp) {
          if (videoRef.current) videoRef.current.style.display = "none";
          if (streamRef.current) streamRef.current.style.display = "block";
          await startRtsp();
        } else {
          if (videoRef.current) videoRef.current.style.display = "block";
          if (streamRef.current) streamRef.current.style.display = "none";
          await startWebcam();
        }

        if (!active) return;
        setStatus("ready");

        if (recognitionEnabled) {
          await ensureFaceApiReady();
          if (active) void loop();
        } else {
          setDetected([]);
        }
      } catch {
        if (active) setStatus("error");
      }
    };

    void init();
    return () => {
      active = false;
      cleanup();
    };
  }, [camera.rtspUrl, camera.type, isRtsp, recognitionEnabled]);

  return (
    <Card className="camera-card" size="small">
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div className="camera-media">
          <video ref={videoRef} className="camera-video" muted playsInline />
          <canvas ref={streamRef} className="camera-video" />
          <canvas ref={overlayRef} className="camera-overlay" />
          {status !== "ready" && (
            <div className="camera-status">
              <VideoCameraOutlined /> {status === "error" ? t.error : t.loading}
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
          {recognitionEnabled ? <Tag color="blue">FPS: {fps}</Tag> : null}
          <Tag color={isRtsp ? "geekblue" : "gold"}>{isRtsp ? "RTSP" : "Webcam"}</Tag>
          {!recognitionEnabled ? <Tag color="cyan">{t.preview}</Tag> : null}
        </Space>

        {recognitionEnabled ? (
          <div>
            <Text type="secondary">{t.recognition}</Text>
            {detected.length === 0 ? (
              <div className="camera-empty">{t.noPeople}</div>
            ) : (
              <div className="camera-people">
                {detected.map((item) => (
                  <div key={`${camera.id}-${item.name}`} className="camera-person">
                    <Text strong>{item.name}</Text>
                    <Tag color={moodTagColor(item.mood)}>{item.mood}</Tag>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Space>
    </Card>
  );
}
