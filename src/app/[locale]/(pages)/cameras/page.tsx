"use client";

import { use, useEffect, useState } from "react";
import { Avatar, Card, Col, Row, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

const { Text } = Typography;
const MAX_RECENT_FIXATIONS = 15;

type Recognition = {
  id: string;
  name: string;
  mood: string;
  detectedAt: string;
};

function formatDetectedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function moodColor(mood: string) {
  const normalized = mood.toLowerCase();
  if (normalized.includes("нег")) return "red";
  if (normalized.includes("поз") || normalized.includes("рад")) return "green";
  if (normalized.includes("трев")) return "orange";
  return "blue";
}

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
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
          if (active) setLoadError(`Ошибка загрузки (${response.status})`);
          return;
        }
        const data = await response.json();
        if (active) {
          const items = Array.isArray(data.items) ? data.items : [];
          setRecentEvents(items.slice(0, MAX_RECENT_FIXATIONS));
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError("Ошибка соединения");
      }
    }

    loadRecent();
    const timer = setInterval(loadRecent, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <MainLayout title="Камеры" locale={locale}>
      <FaceScripts />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="Камеры" className="soft-card">
            <CameraGrid />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Последние фиксации" className="soft-card">
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
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
                        <Text type="secondary">
                          {formatDetectedAt(item.detectedAt)}
                        </Text>
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
