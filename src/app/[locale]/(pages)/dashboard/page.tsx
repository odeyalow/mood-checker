"use client";

import { use, useEffect, useState } from "react";
import {
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
  Avatar,
} from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";

const { Text } = Typography;

type Recognition = {
  id: string;
  name: string;
  mood: string;
  detectedAt: string;
};

type DashboardStats = {
  connectedCameras: number;
  recognitionsLast24h: number;
  negativePercent: number;
  negativeDeltaVsPrevDay: number;
  riskZoneCount: number;
};

type EmotionPoint = {
  bucketStart: string;
  totalStudents: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
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

function deltaText(delta: number) {
  if (delta > 0) return `+${delta}% к прошлому дню`;
  if (delta < 0) return `${delta}% к прошлому дню`;
  return "Без изменений к прошлому дню";
}

export default function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const [recentEvents, setRecentEvents] = useState<Recognition[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [emotionPoints, setEmotionPoints] = useState<EmotionPoint[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadDashboardData() {
      try {
        const [recentResponse, statsResponse, dynamicsResponse] = await Promise.all([
          fetch("/api/recognitions?limit=3", { cache: "no-store" }),
          fetch("/api/dashboard-stats", { cache: "no-store" }),
          fetch("/api/emotion-dynamics", { cache: "no-store" }),
        ]);

        if (!recentResponse.ok || !statsResponse.ok || !dynamicsResponse.ok) {
          if (active) {
            const status = !recentResponse.ok
              ? recentResponse.status
              : !statsResponse.ok
                ? statsResponse.status
                : dynamicsResponse.status;
            setLoadError(`Ошибка загрузки (${status})`);
          }
          return;
        }

        const [recentData, statsData, dynamicsData] = await Promise.all([
          recentResponse.json(),
          statsResponse.json(),
          dynamicsResponse.json(),
        ]);

        if (active) {
          if (Array.isArray(recentData.items)) {
            setRecentEvents(recentData.items);
          }
          if (Array.isArray(dynamicsData.points)) {
            setEmotionPoints(dynamicsData.points);
          }
          setStats(statsData);
          setLoadError(null);
        }
      } catch {
        if (active) {
          setLoadError("Ошибка соединения");
        }
      }
    }

    loadDashboardData();
    const timer = setInterval(loadDashboardData, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <MainLayout title="Главный дэшборд" locale={locale}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title="Активные камеры" value={stats?.connectedCameras ?? 0} />
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title="Распознаваний" value={stats?.recognitionsLast24h ?? 0} />
                <Text type="secondary">За 24 часа</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic
                  title="Негатив"
                  value={stats?.negativePercent ?? 0}
                  suffix="%"
                  styles={{ content: { color: "#dc2626" } }}
                />
                <Text type="secondary">{deltaText(stats?.negativeDeltaVsPrevDay ?? 0)}</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title="Зона риска" value={stats?.riskZoneCount ?? 0} />
                <Text type="secondary">За 24 часа</Text>
              </Card>
            </Col>
          </Row>

          <Card
            title="Динамика эмоций"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <EmotionTimelineChart points={emotionPoints} />
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                Обновляется раз в минуту, окно 24 часа.
              </Text>
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="Последние распознавания" className="soft-card">
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
                        <Text type="secondary">{formatDetectedAt(item.detectedAt)}</Text>
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
