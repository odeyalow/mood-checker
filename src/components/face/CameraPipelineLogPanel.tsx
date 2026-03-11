"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Space, Typography } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";

const { Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

type WorkerStatus = {
  candidate?: number;
  confirmed?: number;
  matchedNames?: string[];
  people?: { name?: string }[];
  personInFrame?: boolean;
  faceInFrame?: boolean;
  frameOk?: boolean;
  frameError?: string;
  lastRecognitionAt?: string;
};

type WorkerStatusPayload = {
  ts?: string;
  cameras?: Record<string, WorkerStatus>;
};

type DedupLogItem = {
  id: string;
  action?: string;
  sourceShortId?: string | null;
};

type Labels = {
  title: string;
  empty: string;
  noFace: string;
  faceFound: string;
  registration: string;
  matchingFailed: string;
  phantomOk: string;
  dbAdded: string;
  frameError: string;
};

type Item = {
  id: string;
  ts: number;
  cameraId: string;
  message: string;
};

function hasMatch(status: WorkerStatus | null | undefined) {
  const names = Array.isArray(status?.matchedNames)
    ? status?.matchedNames?.filter((v) => String(v || "").trim())
    : [];
  const people = Array.isArray(status?.people)
    ? status?.people?.filter((p) => String(p?.name || "").trim())
    : [];
  return names.length > 0 || people.length > 0;
}

function formatTime(ts: number, locale: AppLocale) {
  return new Date(ts).toLocaleTimeString(
    locale === "kz" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );
}

export default function CameraPipelineLogPanel({
  locale,
  labels,
}: {
  locale: AppLocale;
  labels: Labels;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const lastStatusRef = useRef<Record<string, WorkerStatus | null>>({});
  const lastByKeyRef = useRef<Record<string, number>>({});
  const seenDedupIdsRef = useRef<Set<string>>(new Set());

  const cameraNameById = useMemo(() => {
    return Object.fromEntries(
      CAMERA_CONFIGS.map((camera) => [camera.id, camera.name || camera.id]),
    ) as Record<string, string>;
  }, []);

  const push = (cameraId: string, message: string, key = message, cooldownMs = 1500) => {
    const now = Date.now();
    const dedupeKey = `${cameraId}:${key}`;
    const lastAt = Number(lastByKeyRef.current[dedupeKey] || 0);
    if (now - lastAt < cooldownMs) return;
    lastByKeyRef.current[dedupeKey] = now;
    setItems((prev) => [{ id: `${now}-${Math.random()}`, ts: now, cameraId, message }, ...prev].slice(0, 120));
  };

  useEffect(() => {
    let mounted = true;
    let timer = 0;

    const tick = async () => {
      if (!mounted) return;
      try {
        const response = await fetch("/api/worker/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`status_http_${response.status}`);
        const payload = (await response.json()) as WorkerStatusPayload;
        const cameras = payload?.cameras || {};

        for (const camera of CAMERA_CONFIGS) {
          const cameraId = camera.id;
          const current = cameras[cameraId] || null;
          const prev = lastStatusRef.current[cameraId] || null;

          if (!current) continue;

          const currentHasMatch = hasMatch(current);
          const prevHasMatch = hasMatch(prev);
          const currentFace = Boolean(current.faceInFrame);
          const prevFace = Boolean(prev?.faceInFrame);
          const currentFrameOk = current.frameOk !== false;

          if (!currentFrameOk && prev?.frameOk !== false) {
            push(cameraId, labels.frameError, "frame_error", 2500);
          }
          if (currentFrameOk && currentFace && !prevFace) {
            push(cameraId, labels.faceFound, "face_found");
          }
          if (currentFrameOk && !currentFace && (prev == null || prevFace)) {
            push(cameraId, labels.noFace, "no_face");
          }

          if (currentFrameOk && currentFace && !currentHasMatch) {
            if (!prevFace || prevHasMatch) {
              push(cameraId, labels.registration, "registration");
            }
            if (Number(current.confirmed || 0) > 0 && Number(current.candidate || 0) > 0) {
              push(cameraId, labels.matchingFailed, "matching_failed", 2800);
            }
          }

          if (current.lastRecognitionAt && current.lastRecognitionAt !== prev?.lastRecognitionAt) {
            push(cameraId, labels.dbAdded, "db_added", 800);
          }

          lastStatusRef.current[cameraId] = current;
        }
      } catch {
        // ignore noisy fetch failures in UI panel
      }

      timer = window.setTimeout(() => {
        void tick();
      }, 1500);
    };

    void tick();
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [labels]);

  useEffect(() => {
    let mounted = true;
    let timer = 0;

    const tick = async () => {
      if (!mounted) return;
      try {
        const response = await fetch("/api/faces/dedup-logs?limit=25", { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as { items?: DedupLogItem[] };
          const logs = Array.isArray(payload?.items) ? payload.items : [];
          for (let idx = logs.length - 1; idx >= 0; idx -= 1) {
            const item = logs[idx];
            if (!item?.id || seenDedupIdsRef.current.has(item.id)) continue;
            seenDedupIdsRef.current.add(item.id);
            const action = String(item.action || "").toLowerCase();
            if (action.startsWith("phantom_")) {
              const cameraId = String(item.sourceShortId || "").trim();
              if (cameraId && cameraNameById[cameraId]) {
                push(cameraId, labels.phantomOk, `phantom_${action}`, 800);
              }
            }
          }
        }
      } catch {
        // ignore fetch failures
      }

      timer = window.setTimeout(() => {
        void tick();
      }, 5000);
    };

    void tick();
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [cameraNameById, labels.phantomOk]);

  return (
    <Card size="small" className="soft-card">
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Text strong>{labels.title}</Text>
        <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
          {!items.length ? (
            <Text type="secondary">{labels.empty}</Text>
          ) : (
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {items.map((item) => (
                <div key={item.id}>
                  <Text type="secondary">
                    {`${formatTime(item.ts, locale)} • ${cameraNameById[item.cameraId] || item.cameraId}`}
                  </Text>
                  <div>
                    <Text>{item.message}</Text>
                  </div>
                </div>
              ))}
            </Space>
          )}
        </div>
      </Space>
    </Card>
  );
}
