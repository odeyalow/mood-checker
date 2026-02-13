"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import type { CameraConfig } from "@/lib/cameras";

const { Text } = Typography;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

type RtspPlayer = {
  destroy?: () => void;
};

type PlayerLoader = (options: {
  url: string;
  canvas: HTMLCanvasElement;
  audio?: boolean;
  disableGl?: boolean;
}) => Promise<RtspPlayer>;

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

async function waitForPlayer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const loadPlayer = window.loadPlayer;
    if (typeof loadPlayer === "function") return loadPlayer as PlayerLoader;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
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
  };
}) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<RtspPlayer | null>(null);
  const streamTokenRef = useRef(0);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [people, setPeople] = useState<{ name: string; emotion?: string }[]>([]);
  const [zoomInput, setZoomInput] = useState<number>(clampZoom(camera.digitalZoom));
  const [appliedZoom, setAppliedZoom] = useState<number>(clampZoom(camera.digitalZoom));

  useEffect(() => {
    setPeople([]);
  }, []);

  useEffect(() => {
    const initialZoom = clampZoom(camera.digitalZoom);
    setZoomInput(initialZoom);
    setAppliedZoom(initialZoom);
  }, [camera.id, camera.digitalZoom]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedZoom(zoomInput);
    }, 220);
    return () => {
      window.clearTimeout(timer);
    };
  }, [zoomInput]);

  useEffect(() => {
    let mounted = true;
    const streamToken = ++streamTokenRef.current;

    async function startStream() {
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
        const zoomQuery =
          appliedZoom > MIN_ZOOM
            ? `&zoom=${encodeURIComponent(appliedZoom.toFixed(1))}`
            : "";
        const url =
          `${wsProto}${location.host}/api/stream?url=${encodeURIComponent(camera.rtspUrl)}` +
          `&client=${encodeURIComponent(`${camera.id}-${Date.now()}`)}${zoomQuery}`;

        const player = await loadPlayer({ url, canvas, audio: false });
        if (!mounted || streamTokenRef.current !== streamToken) {
          safeDestroyPlayer(player);
          return;
        }
        playerRef.current = player;
        setStatus("ready");
      } catch (error) {
        console.error("[camera] stream error:", error);
        if (mounted && streamTokenRef.current === streamToken) {
          setStatus("error");
        }
      }
    }

    void startStream();
    return () => {
      mounted = false;
      safeDestroyPlayer(playerRef.current);
      playerRef.current = null;
    };
  }, [camera.id, camera.rtspUrl, appliedZoom]);

  useEffect(() => {
    if (status !== "ready") return;

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
            matchedNames?: string[];
            matchDistance?: number;
            emotionSummary?: string;
            topEmotion?: string;
            people?: { name: string; emotion?: string }[];
          } | null;
        };

        const ws = payload.status;
        if (ws) {
          if (Array.isArray(ws.people)) {
            setPeople(
              ws.people
                .map((p) => ({
                  name: String(p?.name ?? "").trim(),
                  emotion: typeof p?.emotion === "string" ? p.emotion : "",
                }))
                .filter((p) => p.name),
            );
          } else {
            const names = Array.isArray(ws.matchedNames) ? ws.matchedNames : [];
            setPeople(names.map((name) => ({ name: String(name), emotion: "" })));
          }
        } else {
          setPeople([]);
        }
      } catch {
        setPeople([]);
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
  }, [status, camera.id]);

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        <canvas ref={streamRef} className="camera-video" />
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
              <Text type="secondary">Zoom</Text>
              <Text type="secondary">{`x${zoomInput.toFixed(1)}`}</Text>
            </div>
            <input
              className="camera-zoom-range"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={zoomInput}
              onChange={(event) => {
                const nextZoom = Number.parseFloat(event.target.value);
                if (!Number.isFinite(nextZoom)) return;
                setZoomInput(clampZoom(nextZoom));
              }}
              aria-label={`${camera.name} zoom`}
            />
          </div>
          {people.length ? (
            <div className="camera-people">
              {people.map((person) => (
                <div key={`${person.name}-${person.emotion || "none"}`} className="camera-person">
                  <Text type="secondary">{person.name}</Text>
                  <Text type="secondary">
                    {person.emotion ? person.emotion : labels.emotion}
                  </Text>
                </div>
              ))}
            </div>
          ) : (
            <div className="camera-empty">
              <Text type="secondary">{labels.noRecognitions}</Text>
            </div>
          )}
        </div>
        <Tag color={people.length ? "green" : "geekblue"}>
          {people.length ? labels.recognized : "RTSP"}
        </Tag>
      </div>
    </Card>
  );
}
