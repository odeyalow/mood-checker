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

export default function CameraTile({ camera }: { camera: CameraConfig }) {
  const streamRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

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

    startStream();
    return () => {
      mounted = false;
    };
  }, [camera.id, camera.rtspUrl]);

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        <canvas ref={streamRef} className="camera-video" />
        {status !== "ready" ? (
          <div className="camera-status">
            <VideoCameraOutlined /> {status === "error" ? "Ошибка" : "Загрузка"}
          </div>
        ) : null}
      </div>
      <div className="camera-footer">
        <div>
          <Text strong>{camera.name}</Text>
          <div>
            <Text type="secondary">{camera.location || camera.id}</Text>
          </div>
        </div>
        <Tag color="geekblue">RTSP</Tag>
      </div>
    </Card>
  );
}
