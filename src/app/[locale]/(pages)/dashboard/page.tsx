"use client";

import { use, useEffect, useState } from "react";
import { Button, Card, Col, Row, Space, Statistic, Tag, Typography, Avatar } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";
import { exportDashboardReport } from "@/components/dashboard/exportDashboardReport";
import { classifyMood } from "@/lib/mood";

const { Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Главный дэшборд",
    activeCameras: "Активные камеры",
    recognitions: "Распознаваний",
    in24h: "За все время",
    negative: "Негатив",
    riskZone: "Зона риска",
    emotionDynamics: "Динамика эмоций",
    dynamicsHint: "Обновляется раз в минуту, окно охватывает всю историю.",
    recentRecognitions: "Последние распознавания",
    noRecognitions: "Пока нет распознаваний",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения",
    allTimeShare: "Доля за все время",
    exportData: "Экспорт данных",
  },
  kz: {
    title: "Басқару панелі",
    activeCameras: "Белсенді камералар",
    recognitions: "Тану саны",
    in24h: "Барлық уақыт ішінде",
    negative: "Негатив",
    riskZone: "Тәуекел аймағы",
    emotionDynamics: "Эмоция динамикасы",
    dynamicsHint: "Әр минут сайын жаңарады, терезе бүкіл тарихты қамтиды.",
    recentRecognitions: "Соңғы танулар",
    noRecognitions: "Әзірге танулар жоқ",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі",
    allTimeShare: "Барлық уақыттағы үлес",
    exportData: "Деректерді экспорттау",
  },
  en: {
    title: "Main Dashboard",
    activeCameras: "Active Cameras",
    recognitions: "Recognitions",
    in24h: "All time",
    negative: "Negative",
    riskZone: "Risk Zone",
    emotionDynamics: "Emotion Dynamics",
    dynamicsHint: "Updated every minute, the chart spans the full history.",
    recentRecognitions: "Recent Recognitions",
    noRecognitions: "No recognitions yet",
    loadError: "Load error",
    connectionError: "Connection error",
    allTimeShare: "All-time share",
    exportData: "Export data",
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
const DASHBOARD_RECENT_LIMIT = 13;

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
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadDashboardData() {
      try {
        const [recentResponse, statsResponse, dynamicsResponse] = await Promise.all([
          fetch(`/api/recognitions?limit=${DASHBOARD_RECENT_LIMIT}`, { cache: "no-store" }),
          fetch("/api/dashboard-stats", { cache: "no-store" }),
          fetch("/api/emotion-dynamics", { cache: "no-store" }),
        ]);
        const [recentData, statsData, dynamicsData] = await Promise.all([
          recentResponse.ok ? recentResponse.json() : null,
          statsResponse.ok ? statsResponse.json() : null,
          dynamicsResponse.ok ? dynamicsResponse.json() : null,
        ]);

        if (!active) return;

        if (Array.isArray(recentData?.items)) setRecentEvents(recentData.items);
        else setRecentEvents([]);

        if (Array.isArray(dynamicsData?.points)) setEmotionPoints(dynamicsData.points);
        else setEmotionPoints([]);

        if (statsData) {
          setStats(statsData);
        } else {
          setStats({
            connectedCameras: 0,
            recognitionsLast24h: 0,
            negativePercent: 0,
            negativeDeltaVsPrevDay: 0,
            riskZoneCount: 0,
          });
        }

        if (!recentResponse.ok) setLoadError(`${t.loadError} (${recentResponse.status})`);
        else setLoadError(null);
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

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportDashboardReport({ stats, emotionPoints, recentEvents, locale: safeLocale });
    } finally {
      setExporting(false);
    }
  };

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <Button type="primary" icon={<DownloadOutlined />} loading={exporting} onClick={handleExport}>
          {t.exportData}
        </Button>
      </div>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={6} style={{ display: "flex" }}>
              <Card
                className="soft-card"
                style={{ width: "100%", height: "100%" }}
                styles={{ body: { display: "flex", flexDirection: "column", gap: 8, height: "100%" } }}
              >
                <Statistic title={t.activeCameras} value={stats?.connectedCameras ?? 0} />
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6} style={{ display: "flex" }}>
              <Card
                className="soft-card"
                style={{ width: "100%", height: "100%" }}
                styles={{ body: { display: "flex", flexDirection: "column", gap: 8, height: "100%" } }}
              >
                <Statistic title={t.recognitions} value={stats?.recognitionsLast24h ?? 0} />
                <Text type="secondary">{t.in24h}</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6} style={{ display: "flex" }}>
              <Card
                className="soft-card"
                style={{ width: "100%", height: "100%" }}
                styles={{ body: { display: "flex", flexDirection: "column", gap: 8, height: "100%" } }}
              >
                <Statistic
                  title={t.negative}
                  value={stats?.negativePercent ?? 0}
                  suffix="%"
                  styles={{ content: { color: "#dc2626" } }}
                />
                <Text type="secondary">{t.allTimeShare}</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6} style={{ display: "flex" }}>
              <Card
                className="soft-card"
                style={{ width: "100%", height: "100%" }}
                styles={{ body: { display: "flex", flexDirection: "column", gap: 8, height: "100%" } }}
              >
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
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
              {loadError ? <Text type="danger">{loadError}</Text> : null}
              {!loadError && recentEvents.length === 0 ? <Text type="secondary">{t.noRecognitions}</Text> : null}
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
                    <Avatar>{(item.name || "?").trim().charAt(0).toUpperCase() || "?"}</Avatar>
                    <div>
                      <Text strong>{item.name || "Unknown"}</Text>
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
