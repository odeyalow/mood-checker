"use client";

import { use, useEffect, useState } from "react";
import { Card, Col, Row, Space, Statistic, Tag, Typography, Avatar } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";
import { classifyMood } from "@/lib/mood";

const { Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Главный дэшборд",
    activeCameras: "Активные камеры",
    recognitions: "Распознаваний",
    in24h: "За 24 часа",
    negative: "Негатив",
    riskZone: "Зона риска",
    emotionDynamics: "Динамика эмоций",
    dynamicsHint: "Обновляется раз в минуту, окно 24 часа.",
    recentRecognitions: "Последние распознавания",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения",
    noChange: "Без изменений к прошлому дню",
    prevDay: "к прошлому дню",
  },
  kz: {
    title: "Басқару панелі",
    activeCameras: "Белсенді камералар",
    recognitions: "Тану саны",
    in24h: "24 сағат ішінде",
    negative: "Негатив",
    riskZone: "Тәуекел аймағы",
    emotionDynamics: "Эмоция динамикасы",
    dynamicsHint: "Әр минут сайын жаңарады, терезе 24 сағат.",
    recentRecognitions: "Соңғы танулар",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі",
    noChange: "Өткен күнмен салыстырғанда өзгеріс жоқ",
    prevDay: "өткен күнмен салыстырғанда",
  },
  en: {
    title: "Main Dashboard",
    activeCameras: "Active Cameras",
    recognitions: "Recognitions",
    in24h: "In 24 hours",
    negative: "Negative",
    riskZone: "Risk Zone",
    emotionDynamics: "Emotion Dynamics",
    dynamicsHint: "Updated every minute, window is 24 hours.",
    recentRecognitions: "Recent Recognitions",
    loadError: "Load error",
    connectionError: "Connection error",
    noChange: "No change vs previous day",
    prevDay: "vs previous day",
  },
} as const;

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
const DASHBOARD_POLL_INTERVAL_MS = 10_000;

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

function deltaText(delta: number, locale: AppLocale) {
  const t = L10N[locale];
  if (delta > 0) return `+${delta}% ${t.prevDay}`;
  if (delta < 0) return `${delta}% ${t.prevDay}`;
  return t.noChange;
}

export default function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

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
            setLoadError(`${t.loadError} (${status})`);
          }
          return;
        }

        const [recentData, statsData, dynamicsData] = await Promise.all([
          recentResponse.json(),
          statsResponse.json(),
          dynamicsResponse.json(),
        ]);

        if (active) {
          if (Array.isArray(recentData.items)) setRecentEvents(recentData.items);
          if (Array.isArray(dynamicsData.points)) setEmotionPoints(dynamicsData.points);
          setStats(statsData);
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError(t.connectionError);
      }
    }

    void loadDashboardData();
    const timer = setInterval(loadDashboardData, DASHBOARD_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [t.connectionError, t.loadError]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title={t.activeCameras} value={stats?.connectedCameras ?? 0} />
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title={t.recognitions} value={stats?.recognitionsLast24h ?? 0} />
                <Text type="secondary">{t.in24h}</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic
                  title={t.negative}
                  value={stats?.negativePercent ?? 0}
                  suffix="%"
                  styles={{ content: { color: "#dc2626" } }}
                />
                <Text type="secondary">{deltaText(stats?.negativeDeltaVsPrevDay ?? 0, safeLocale)}</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title={t.riskZone} value={stats?.riskZoneCount ?? 0} />
                <Text type="secondary">{t.in24h}</Text>
              </Card>
            </Col>
          </Row>

          <Card title={t.emotionDynamics} style={{ marginTop: 16 }} className="soft-card">
            <EmotionTimelineChart points={emotionPoints} locale={safeLocale} />
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">{t.dynamicsHint}</Text>
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title={t.recentRecognitions} className="soft-card">
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
