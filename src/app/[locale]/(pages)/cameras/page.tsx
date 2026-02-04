"use client";

import { use, useEffect, useState } from "react";
import { Avatar, Card, Col, Row, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";
import { classifyMood } from "@/lib/mood";

const { Text } = Typography;
const MAX_RECENT_FIXATIONS = 15;
const RECENT_POLL_INTERVAL_MS = 10_000;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Камеры",
    cameras: "Камеры",
    recent: "Последние фиксации",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения",
  },
  kz: {
    title: "Камералар",
    cameras: "Камералар",
    recent: "Соңғы фиксациялар",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі",
  },
  en: {
    title: "Cameras",
    cameras: "Cameras",
    recent: "Recent Events",
    loadError: "Load error",
    connectionError: "Connection error",
  },
} as const;

type Recognition = {
  id: string;
  name: string;
  mood: string;
  detectedAt: string;
};

function formatDetectedAt(value: string, locale: AppLocale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(locale === "kz" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function moodColor(mood: string) {
  const kind = classifyMood(mood);
  if (kind === "negative") return "red";
  if (kind === "positive") return "green";
  return "blue";
}

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [recentEvents, setRecentEvents] = useState<Recognition[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadRecent() {
      try {
        const response = await fetch(`/api/recognitions?limit=${MAX_RECENT_FIXATIONS}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (active) setLoadError(`${t.loadError} (${response.status})`);
          return;
        }

        const data = await response.json();
        if (active) {
          const items = Array.isArray(data.items) ? data.items : [];
          setRecentEvents(items.slice(0, MAX_RECENT_FIXATIONS));
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError(t.connectionError);
      }
    }

    void loadRecent();
    const timer = setInterval(loadRecent, RECENT_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [t.connectionError, t.loadError]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <FaceScripts />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title={t.cameras} className="soft-card">
            <CameraGrid locale={safeLocale} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={t.recent} className="soft-card">
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              {loadError ? <Text type="danger">{loadError}</Text> : null}
              {recentEvents.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <Space>
                    <Avatar>{item.name[0]}</Avatar>
                    <div>
                      <Text strong>{item.name}</Text>
                      <div>
                        <Text type="secondary">{formatDetectedAt(item.detectedAt, safeLocale)}</Text>
                      </div>
                    </div>
                  </Space>
                  <Tag color={moodColor(item.mood)}>{item.mood}</Tag>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>
    </MainLayout>
  );
}
