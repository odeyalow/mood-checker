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
  faceInFrame?: boolean;
  frameOk?: boolean;
  frameError?: string;
  lastRecognitionAt?: string;
};

type WorkerStatusPayload = {
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

type LogItem = {
  id: string;
  ts: number;
  message: string;
};

type Stage = "frame_error" | "idle" | "matching" | "registering" | "matched";

// Forward-only ordering of pipeline stages within a single face appearance.
const STAGE_RANK: Record<Stage, number> = {
  frame_error: -1,
  idle: 0,
  matching: 1,
  registering: 2,
  matched: 3,
};

// Tolerate brief detector dropouts (face flickers out for a poll or two) so the
// log does not cycle "face found -> matching -> face found ...".
const FACE_PRESENCE_GRACE_MS = 3500;

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
  return Array.from(names).sort();
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
  const singleCamera = CAMERA_CONFIGS.length === 1;
  const [itemsByCamera, setItemsByCamera] = useState<Record<string, LogItem[]>>(() =>
    Object.fromEntries(CAMERA_CONFIGS.map((camera) => [camera.id, []])),
  );

  const stageRef = useRef<Record<string, Stage>>({});
  const lastStatusRef = useRef<Record<string, WorkerStatus | null>>({});
  const lastByKeyRef = useRef<Record<string, number>>({});
  const seenDedupIdsRef = useRef<Set<string>>(new Set());
  const presenceRef = useRef<Record<string, { active: boolean; lastSeenAt: number }>>({});
  const sessionRankRef = useRef<Record<string, number>>({});
  // Keys already logged during the current face appearance (reset on each new one).
  const sessionLogRef = useRef<Record<string, Set<string>>>({});

  const cameraNameById = useMemo(
    () => Object.fromEntries(CAMERA_CONFIGS.map((camera) => [camera.id, camera.name || camera.id])),
    [],
  ) as Record<string, string>;

  const push = (cameraId: string, message: string, key = message, cooldownMs = 1200) => {
    const now = Date.now();
    const dedupeKey = `${cameraId}:${key}`;
    const lastAt = Number(lastByKeyRef.current[dedupeKey] || 0);
    if (now - lastAt < cooldownMs) return;
    lastByKeyRef.current[dedupeKey] = now;

    setItemsByCamera((prev) => {
      const prevItems = prev[cameraId] || [];
      const nextItems = [{ id: `${now}-${Math.random()}`, ts: now, message }, ...prevItems].slice(0, 80);
      return { ...prev, [cameraId]: nextItems };
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

          const now = Date.now();
          const frameOk = current.frameOk !== false;
          const prevFrameOk = prev ? prev.frameOk !== false : true;
          const confirmed = Number(current.confirmed || 0) > 0;
          const names = getMatchedNames(current);
          const hasMatch = names.length > 0;
          const faceSignal = Boolean(current.faceInFrame) || confirmed || hasMatch;

          // Debounce face presence: a face flickering in/out of detection on
          // consecutive polls must not restart the pipeline log cycle.
          const presence = presenceRef.current[cameraId] || { active: false, lastSeenAt: 0 };
          if (faceSignal) presence.lastSeenAt = now;
          const faceActive =
            frameOk &&
            (faceSignal || (presence.active && now - presence.lastSeenAt < FACE_PRESENCE_GRACE_MS));
          const wasActive = presence.active;
          presence.active = faceActive;
          presenceRef.current[cameraId] = presence;

          let stage: Stage;
          if (!frameOk) stage = "frame_error";
          else if (!faceActive) stage = "idle";
          else if (hasMatch) stage = "matched";
          else if (confirmed) stage = "registering";
          else stage = "matching";

          // Fresh face appearance (debounced rising edge): reset the per-appearance
          // log set and stage progression so the next person logs cleanly.
          if (faceActive && !wasActive) {
            sessionRankRef.current[cameraId] = 0;
            sessionLogRef.current[cameraId] = new Set();
          }
          const sessionLog =
            sessionLogRef.current[cameraId] || (sessionLogRef.current[cameraId] = new Set());

          // Announce each matched identity at most once per appearance, so match
          // flicker (who=ID -> unknown -> ID, common for people passing at an angle)
          // can never spam the log.
          const announceMatch = () => {
            if (!names.length) return;
            const fresh = names.some((n) => !sessionLog.has(`m:${n}`));
            if (!fresh) return;
            for (const n of names) sessionLog.add(`m:${n}`);
            push(cameraId, `${labels.matchingSuccess}: ${names.join(", ")}`, `matched:${names.join(",")}`, 900);
          };

          if (faceActive && !sessionLog.has("face_found")) {
            sessionLog.add("face_found");
            push(cameraId, labels.faceFound, "face_found", FACE_PRESENCE_GRACE_MS);
          }

          const prevStage = stageRef.current[cameraId];
          const sessionMaxRank = Number(sessionRankRef.current[cameraId] || 0);
          const rank = STAGE_RANK[stage];
          const isReset = stage === "idle" || stage === "frame_error";
          // Within one appearance the log only moves forward (matching -> registering
          // -> matched); backward flicker (matched -> matching) is ignored.
          const advanced = stage !== prevStage && (isReset || rank > sessionMaxRank);
          if (advanced) {
            if (stage === "frame_error") {
              const frameError = String(current.frameError || "").trim();
              push(
                cameraId,
                frameError ? `${labels.frameError}: ${frameError}` : labels.frameError,
                "stage_frame_error",
                2000,
              );
            } else if (stage === "idle") {
              push(cameraId, labels.noFace, "stage_idle", 1000);
            } else if (stage === "matching") {
              push(cameraId, labels.matchingPending, "stage_matching", 1000);
            } else if (stage === "registering") {
              if (sessionMaxRank < STAGE_RANK.matching) {
                push(cameraId, labels.matchingPending, "stage_matching_before_register", 1000);
              }
              push(cameraId, labels.registrationAttempt, "stage_registering", 1400);
            } else if (stage === "matched") {
              announceMatch();
            }
            sessionRankRef.current[cameraId] = isReset ? 0 : Math.max(sessionMaxRank, rank);
          }

          if (frameOk && !prevFrameOk) {
            push(cameraId, labels.frameRestored, "frame_restored", 1200);
          }
          if (hasMatch) {
            announceMatch();
          }
          if (current.lastRecognitionAt && current.lastRecognitionAt !== prev?.lastRecognitionAt) {
            push(cameraId, labels.dbAdded, "db_added", 700);
          }

          stageRef.current[cameraId] = stage;
          lastStatusRef.current[cameraId] = current;
        }
      } catch {
        // no-op
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

            const action = String(item.action || "").toLowerCase();
            const isPhantomEvent = action.startsWith("phantom_") || action === "auto_quarantine_blocked";
            if (!isPhantomEvent) continue;

            const cameraId = String(item.sourceShortId || "").trim();
            if (!cameraId || !cameraNameById[cameraId]) continue;
            push(cameraId, labels.phantomBlocked, `phantom:${action}`, 1000);
          }
        }
      } catch {
        // no-op
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
              <Col key={camera.id} xs={24} md={singleCamera ? 24 : 12}>
                <Card size="small" title={camera.name || camera.id}>
                  <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                    {!rows.length ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={labels.empty} />
                    ) : (
                      <Space direction="vertical" size={6} style={{ width: "100%" }}>
                        {rows.map((row) => (
                          <div key={row.id}>
                            <Text type="secondary">{formatTime(row.ts, locale)}</Text>
                            <div>
                              <Text>{row.message}</Text>
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
