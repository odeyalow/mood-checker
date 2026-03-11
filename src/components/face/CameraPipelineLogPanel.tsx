"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Col, Empty, Row, Space, Typography } from "antd";
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
  matchingPending: string;
  matchingSuccess: string;
  registrationAttempt: string;
  phantomBlocked: string;
  dbAdded: string;
  frameError: string;
  frameRestored: string;
};

type Item = {
  id: string;
  ts: number;
  message: string;
};

function getMatchedNames(status: WorkerStatus | null | undefined) {
  const names = new Set<string>();
  if (Array.isArray(status?.matchedNames)) {
    for (const name of status.matchedNames) {
      const safe = String(name || "").trim();
      if (safe) names.add(safe);
    }
  }
  if (Array.isArray(status?.people)) {
    for (const person of status.people) {
      const safe = String(person?.name || "").trim();
      if (safe) names.add(safe);
    }
  }
  return Array.from(names);
}

function areSameNames(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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
  const [itemsByCamera, setItemsByCamera] = useState<Record<string, Item[]>>(() =>
    Object.fromEntries(CAMERA_CONFIGS.map((camera) => [camera.id, []])),
  );
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
    setItemsByCamera((prev) => {
      const prevList = Array.isArray(prev[cameraId]) ? prev[cameraId] : [];
      const nextList = [{ id: `${now}-${Math.random()}`, ts: now, message }, ...prevList].slice(0, 80);
      return { ...prev, [cameraId]: nextList };
    });
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

          const currentFrameOk = current.frameOk !== false;
          const prevFrameOk = prev ? prev.frameOk !== false : true;
          const currentFace = Boolean(current.faceInFrame);
          const prevFace = Boolean(prev?.faceInFrame);
          const currentNames = getMatchedNames(current).sort();
          const prevNames = getMatchedNames(prev).sort();
          const hasMatch = currentNames.length > 0;
          const hadMatch = prevNames.length > 0;

          if (!currentFrameOk && prevFrameOk) {
            const frameError = String(current.frameError || "").trim();
            push(
              cameraId,
              frameError ? `${labels.frameError}: ${frameError}` : labels.frameError,
              "frame_error",
              3000,
            );
          }
          if (currentFrameOk && !prevFrameOk) {
            push(cameraId, labels.frameRestored, "frame_restored", 2500);
          }

          if (currentFrameOk && currentFace && !prevFace) {
            push(cameraId, labels.faceFound, "face_found", 800);
          }
          if (currentFrameOk && !currentFace && (prev == null || prevFace)) {
            push(cameraId, labels.noFace, "no_face", 1800);
          }

          if (currentFrameOk && currentFace && !hasMatch) {
            push(cameraId, labels.matchingPending, "matching_pending", 2400);
            if (Number(current.confirmed || 0) > 0) {
              push(cameraId, labels.registrationAttempt, "registration_attempt", 2800);
            }
          }

          if (hasMatch && (!hadMatch || !areSameNames(currentNames, prevNames))) {
            push(
              cameraId,
              `${labels.matchingSuccess}: ${currentNames.join(", ")}`,
              `matching_success:${currentNames.join(",")}`,
              1200,
            );
          }

          if (current.lastRecognitionAt && current.lastRecognitionAt !== prev?.lastRecognitionAt) {
            push(cameraId, labels.dbAdded, "db_added", 700);
          }

          lastStatusRef.current[cameraId] = current;
        }
      } catch {
        // ignore UI polling failures
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
        const response = await fetch("/api/faces/dedup-logs?limit=40", { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as { items?: DedupLogItem[] };
          const logs = Array.isArray(payload?.items) ? payload.items : [];
          for (let idx = logs.length - 1; idx >= 0; idx -= 1) {
            const item = logs[idx];
            if (!item?.id || seenDedupIdsRef.current.has(item.id)) continue;
            seenDedupIdsRef.current.add(item.id);

            const action = String(item.action || "").trim().toLowerCase();
            if (!action.startsWith("phantom_")) continue;

            const cameraId = String(item.sourceShortId || "").trim();
            if (!cameraId || !cameraNameById[cameraId]) continue;
            push(cameraId, labels.phantomBlocked, `phantom:${action}`, 800);
          }
        }
      } catch {
        // ignore UI polling failures
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
  }, [cameraNameById, labels.phantomBlocked]);

  return (
    <Card size="small" className="soft-card">
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Text strong>{labels.title}</Text>
        <Row gutter={[12, 12]}>
          {CAMERA_CONFIGS.map((camera) => {
            const rows = itemsByCamera[camera.id] || [];
            return (
              <Col key={camera.id} xs={24} md={12}>
                <Card size="small" title={camera.name || camera.id}>
                  <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                    {!rows.length ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={labels.empty} />
                    ) : (
                      <Space direction="vertical" size={6} style={{ width: "100%" }}>
                        {rows.map((item) => (
                          <div key={item.id}>
                            <Text type="secondary">{formatTime(item.ts, locale)}</Text>
                            <div>
                              <Text>{item.message}</Text>
                            </div>
                          </div>
                        ))}
                      </Space>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      </Space>
    </Card>
  );
}
