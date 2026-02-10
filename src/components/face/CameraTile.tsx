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
}: {
  camera: CameraConfig;
}) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [matchedNames, setMatchedNames] = useState<string[]>([]);
  const [topEmotion, setTopEmotion] = useState<string>("");

  useEffect(() => {
    setMatchedNames([]);
    setTopEmotion("");
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
          } | null;
        };

        const ws = payload.status;
        if (ws) {
          setMatchedNames(Array.isArray(ws.matchedNames) ? ws.matchedNames : []);
          setTopEmotion(typeof ws.topEmotion === "string" ? ws.topEmotion : "");
        } else {
          setMatchedNames([]);
          setTopEmotion("");
        }
      } catch {
        setMatchedNames([]);
        setTopEmotion("");
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
              {matchedNames.length ? `Recognized: ${matchedNames.join(", ")}` : "Recognized: -"}
            </Text>
          </div>
          <div>
            <Text type="secondary">
              {topEmotion ? `Emotion: ${topEmotion}` : "Emotion: -"}
            </Text>
          </div>
        </div>
        <Tag color={matchedNames.length ? "green" : "geekblue"}>
          {matchedNames.length ? "Recognized" : "RTSP"}
        </Tag>
      </div>
    </Card>
  );
}
