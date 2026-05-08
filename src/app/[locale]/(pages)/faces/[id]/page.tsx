"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Card, Col, Empty, Progress, Row, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";

const { Text, Title } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Карточка лица",
    photos: "Последние 5 снимков",
    history: "История эмоций за все время",
    chart: "График эмоций за все время",
    notFound: "Лицо не найдено",
    loadError: "Ошибка загрузки",
    camera: "Камера",
    mood: "Эмоция",
    recognizedAt: "Распознано",
    total: "Всего",
    noImage: "Нет снимка",
    positive: "Позитив",
    neutral: "Нейтрально",
    negative: "Негатив",
    risk: "Риск",
  },
  kz: {
    title: "Тұлға картасы",
    photos: "Соңғы 5 сурет",
    history: "Барлық уақыттағы эмоция тарихы",
    chart: "Барлық уақыттағы эмоция графигі",
    notFound: "Тұлға табылмады",
    loadError: "Жүктеу қатесі",
    camera: "Камера",
    mood: "Эмоция",
    recognizedAt: "Танылған уақыты",
    total: "Барлығы",
    noImage: "Сурет жоқ",
    positive: "Позитив",
    neutral: "Нейтрал",
    negative: "Негатив",
    risk: "Тәуекел",
  },
  en: {
    title: "Face Card",
    photos: "Last 5 images",
    history: "All-time emotion history",
    chart: "All-time emotion chart",
    notFound: "Face not found",
    loadError: "Load error",
    camera: "Camera",
    mood: "Mood",
    recognizedAt: "Recognized at",
    total: "Total",
    noImage: "No image",
    positive: "Positive",
    neutral: "Neutral",
    negative: "Negative",
    risk: "Risk",
  },
} as const;

type FaceImage = {
  id: string;
  snapshotUrl: string;
  mood: string;
  cameraId: string;
  detectedAt: string;
};

type FacePayload = {
  face: {
    id: string;
    shortId: string;
    recognitionCount: number;
    createdAt: string;
    updatedAt: string;
    stats: {
      positiveCount: number;
      neutralCount: number;
      negativeCount: number;
      positivePercent: number;
      neutralPercent: number;
      negativePercent: number;
      riskPercent: number;
    };
  };
  images: FaceImage[];
  history: FaceImage[];
  timelinePoints: Array<{
    bucketStart: string;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  }>;
};

function formatDateTime(value: string, locale: AppLocale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === "kz" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FaceDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [data, setData] = useState<FacePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFace = useCallback(async () => {
    try {
      const response = await fetch(`/api/faces/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) {
        setLoadError(response.status === 404 ? t.notFound : `${t.loadError} (${response.status})`);
        return;
      }
      const payload = await response.json();
      setData(payload);
      setLoadError(null);
    } catch {
      setLoadError(t.loadError);
    }
  }, [id, t.loadError, t.notFound]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (!mounted) return;
      await loadFace();
    };
    void run();
    const timer = setInterval(() => {
      void run();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [loadFace]);

  const title = data?.face?.shortId ? `${t.title}: ${data.face.shortId}` : t.title;

  return (
    <MainLayout title={title} locale={safeLocale}>
      {loadError ? <Text type="danger">{loadError}</Text> : null}

      {!data ? (
        <Card className="soft-card" style={{ marginTop: 16 }}>
          <Empty description={t.notFound} />
        </Card>
      ) : (
        <Card className="soft-card">
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <div>
              <Title level={4} style={{ marginBottom: 4 }}>
                {data.face.shortId}
              </Title>
              <Space wrap>
                <Tag>{`${t.total}: ${data.face.recognitionCount}`}</Tag>
                <Tag color="green">{`${t.positive}: ${data.face.stats.positiveCount}`}</Tag>
                <Tag color="blue">{`${t.neutral}: ${data.face.stats.neutralCount}`}</Tag>
                <Tag color="red">{`${t.negative}: ${data.face.stats.negativeCount}`}</Tag>
                <Tag color="orange">{`${t.risk}: ${data.face.stats.riskPercent}%`}</Tag>
              </Space>
            </div>

            <Card size="small">
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Title level={5} style={{ marginTop: 0 }}>
                    {t.chart}
                  </Title>
                  <EmotionTimelineChart points={data.timelinePoints ?? []} locale={safeLocale} />
                </Col>
                <Col xs={24} md={12}>
                  <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <div>
                      <Text>{`${t.positive}: ${data.face.stats.positivePercent}%`}</Text>
                      <Progress percent={data.face.stats.positivePercent} showInfo={false} strokeColor="#22c55e" />
                    </div>
                    <div>
                      <Text>{`${t.neutral}: ${data.face.stats.neutralPercent}%`}</Text>
                      <Progress percent={data.face.stats.neutralPercent} showInfo={false} strokeColor="#3b82f6" />
                    </div>
                    <div>
                      <Text>{`${t.negative}: ${data.face.stats.negativePercent}%`}</Text>
                      <Progress percent={data.face.stats.negativePercent} showInfo={false} strokeColor="#ef4444" />
                    </div>
                  </Space>
                </Col>
              </Row>
            </Card>

            <Title level={5} style={{ margin: 0 }}>
              {t.photos}
            </Title>

            {!data.images?.length ? (
              <Empty description={t.notFound} />
            ) : (
              <Row gutter={[16, 16]}>
                {data.images.map((image) => (
                  <Col xs={24} sm={12} md={8} lg={8} key={image.id}>
                    <Card
                      size="small"
                      cover={
                        image.snapshotUrl ? (
                          <img
                            src={image.snapshotUrl}
                            alt={data.face.shortId}
                            style={{ width: "100%", height: 220, objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: 220,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#f5f5f5",
                            }}
                          >
                            <Text type="secondary">{t.noImage}</Text>
                          </div>
                        )
                      }
                    >
                      <Space direction="vertical" size={4}>
                        <Text type="secondary">{`${t.camera}: ${image.cameraId || "-"}`}</Text>
                        <Text type="secondary">{`${t.mood}: ${image.mood || "-"}`}</Text>
                        <Text type="secondary">
                          {`${t.recognizedAt}: ${formatDateTime(image.detectedAt, safeLocale)}`}
                        </Text>
                      </Space>
                    </Card>
                  </Col>
                ))}
              </Row>
            )}

            <Title level={5} style={{ margin: 0 }}>
              {t.history}
            </Title>

            {!data.history?.length ? (
              <Empty description={t.notFound} />
            ) : (
              <Row gutter={[16, 16]}>
                {data.history.map((image) => (
                  <Col xs={24} sm={12} md={8} lg={6} key={`history-${image.id}`}>
                    <Card
                      size="small"
                      cover={
                        image.snapshotUrl ? (
                          <img
                            src={image.snapshotUrl}
                            alt={data.face.shortId}
                            style={{ width: "100%", height: 180, objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: 180,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#f5f5f5",
                            }}
                          >
                            <Text type="secondary">{t.noImage}</Text>
                          </div>
                        )
                      }
                    >
                      <Space direction="vertical" size={4}>
                        <Text type="secondary">{`${t.camera}: ${image.cameraId || "-"}`}</Text>
                        <Text type="secondary">{`${t.mood}: ${image.mood || "-"}`}</Text>
                        <Text type="secondary">
                          {`${t.recognizedAt}: ${formatDateTime(image.detectedAt, safeLocale)}`}
                        </Text>
                      </Space>
                    </Card>
                  </Col>
                ))}
              </Row>
            )}
          </Space>
        </Card>
      )}
    </MainLayout>
  );
}
