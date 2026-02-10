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

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [people, setPeople] = useState<{ name: string; emotion?: string }[]>([]);

  useEffect(() => {
    setPeople([]);
  }, []);

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
