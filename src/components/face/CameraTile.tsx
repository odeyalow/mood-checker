"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import type { CameraConfig } from "@/lib/cameras";

const { Text } = Typography;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;
const WORKER_ZOOM_PRESETS = [1, 2, 3, 4, 5];
const STREAM_START_TIMEOUT_MS = 12000;
const STREAM_RETRY_DELAY_MS = 3000;
const STREAM_DISCONNECT_THRESHOLD_MS = 5000;

type RtspPlayer = {
  destroy?: () => void;
};

type PlayerLoader = (options: {
  url: string;
  canvas: HTMLCanvasElement;
  audio?: boolean;
  disableGl?: boolean;
  disconnectThreshold?: number;
  onDisconnect?: (player: RtspPlayer) => void;
}) => Promise<RtspPlayer>;

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
  people?: WorkerPerson[];
  snapshotUrl?: string;
  lastRecognitionAt?: string;
  frameOk?: boolean;
  workerZoom?: number;
};

type SnapshotHistoryItem = {
  id: string;
  snapshotUrl: string;
  who: string;
  emotion: string;
  capturedAt: string;
};

function safeDestroyPlayer(player: RtspPlayer | null) {
  if (!player?.destroy) return;
  try {
    player.destroy();
  } catch (error) {
    console.error("[camera] player destroy error:", error);
  }
}

function clampZoom(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MIN_ZOOM;
  const clamped = Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
  return Number(clamped.toFixed(1));
}

function clampWorkerZoom(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const clamped = Math.min(5, Math.max(1, value));
  return Number(clamped.toFixed(1));
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

async function waitForPlayer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const loadPlayer = window.loadPlayer;
    if (typeof loadPlayer === "function") return loadPlayer as PlayerLoader;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function loadPlayerWithTimeout(
  loadPlayer: PlayerLoader,
  options: Parameters<PlayerLoader>[0],
  timeoutMs = STREAM_START_TIMEOUT_MS,
): Promise<RtspPlayer> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("rtsp_stream_start_timeout"));
    }, timeoutMs);

    loadPlayer(options)
      .then((player) => {
        window.clearTimeout(timeoutId);
        resolve(player);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
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
  };
}) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<RtspPlayer | null>(null);
  const streamTokenRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastSnapshotKeyRef = useRef("");

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [people, setPeople] = useState<WorkerPerson[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState("");
  const [snapshotWho, setSnapshotWho] = useState("");
  const [snapshotEmotion, setSnapshotEmotion] = useState("");
  const [lastRecognitionAt, setLastRecognitionAt] = useState("");
  const [history, setHistory] = useState<SnapshotHistoryItem[]>([]);
  const [zoomValue, setZoomValue] = useState<number>(clampZoom(camera.digitalZoom));
  const [workerZoom, setWorkerZoom] = useState(1);
  const [workerZoomSaving, setWorkerZoomSaving] = useState(false);

  useEffect(() => {
    setPeople([]);
    setSnapshotUrl("");
    setSnapshotWho("");
    setSnapshotEmotion("");
    setLastRecognitionAt("");
    setHistory([]);
    setWorkerZoom(1);
    lastSnapshotKeyRef.current = "";
  }, [camera.id]);

  useEffect(() => {
    const initialZoom = clampZoom(camera.digitalZoom);
    setZoomValue(initialZoom);
  }, [camera.id, camera.digitalZoom]);

  useEffect(() => {
    let mounted = true;
    let attemptSeq = 0;
    const streamToken = ++streamTokenRef.current;

    function clearReconnectTimer() {
      if (reconnectTimerRef.current === null) return;
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    function scheduleReconnect(delayMs = STREAM_RETRY_DELAY_MS) {
      if (!mounted || streamTokenRef.current !== streamToken) return;
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!mounted || streamTokenRef.current !== streamToken) return;
        void startStream();
      }, delayMs);
    }

    async function startStream() {
      const attemptId = ++attemptSeq;
      clearReconnectTimer();

      const canvas = streamRef.current;
      if (!canvas) return;

      setStatus("loading");
      safeDestroyPlayer(playerRef.current);
      playerRef.current = null;

      try {
        const loadPlayer = await waitForPlayer();
        if (!loadPlayer) throw new Error("rtsp_player_missing");
        if (!mounted || streamTokenRef.current !== streamToken) return;

        const wsProto = location.protocol === "https:" ? "wss://" : "ws://";
        const url =
          `${wsProto}${location.host}/api/stream?url=${encodeURIComponent(camera.rtspUrl)}` +
          `&client=${encodeURIComponent(`${camera.id}-${Date.now()}`)}`;

        const player = await loadPlayerWithTimeout(loadPlayer, {
          url,
          canvas,
          audio: false,
          disableGl: true,
          disconnectThreshold: STREAM_DISCONNECT_THRESHOLD_MS,
          onDisconnect: () => {
            if (!mounted || streamTokenRef.current !== streamToken) return;
            safeDestroyPlayer(playerRef.current);
            playerRef.current = null;
            setStatus("error");
            scheduleReconnect();
          },
        });

        if (!mounted || streamTokenRef.current !== streamToken || attemptSeq !== attemptId) {
          safeDestroyPlayer(player);
          return;
        }
        playerRef.current = player;
        setStatus("ready");
      } catch (error) {
        console.error("[camera] stream error:", error);
        if (mounted && streamTokenRef.current === streamToken && attemptSeq === attemptId) {
          setStatus("error");
          scheduleReconnect();
        }
      }
    }

    void startStream();
    return () => {
      mounted = false;
      clearReconnectTimer();
      safeDestroyPlayer(playerRef.current);
      playerRef.current = null;
    };
  }, [camera.id, camera.rtspUrl]);

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

          setWorkerZoom(zoom);

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
            (typeof ws.topEmotion === "string" && ws.topEmotion.trim().length > 0
              ? ws.topEmotion.trim()
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
  }, [camera.id]);

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

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        <canvas
          ref={streamRef}
          className="camera-video"
          style={{
            transform: zoomValue > MIN_ZOOM ? `scale(${zoomValue})` : "scale(1)",
            transformOrigin: "center center",
            transition: "transform 0.16s ease-out",
          }}
        />
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

          <div className="camera-zoom">
            <div className="camera-zoom-head">
              <Text type="secondary">Zoom (UI)</Text>
              <Text type="secondary">{`x${zoomValue.toFixed(1)}`}</Text>
            </div>
            <input
              className="camera-zoom-range"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={zoomValue}
              onChange={(event) => {
                const nextZoom = Number.parseFloat(event.target.value);
                if (!Number.isFinite(nextZoom)) return;
                setZoomValue(clampZoom(nextZoom));
              }}
              aria-label={`${camera.name} ui zoom`}
            />
          </div>

          <div className="camera-worker-zoom">
            <div className="camera-zoom-head">
              <Text type="secondary">Zoom (worker)</Text>
              <Text type="secondary">{`x${workerZoom.toFixed(1)}`}</Text>
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
          {people.length ? labels.recognized : "RTSP"}
        </Tag>
      </div>
    </Card>
  );
}
