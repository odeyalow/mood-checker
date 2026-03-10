"use client";

import { use, useEffect, useState } from "react";
import { Card, Col, Empty, Row, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";

const { Text, Title } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u043b\u0438\u0446\u0430",
    photos: "\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0435 5 \u0441\u043d\u0438\u043c\u043a\u043e\u0432",
    notFound: "\u041b\u0438\u0446\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e",
    loadError: "\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438",
    camera: "\u041a\u0430\u043c\u0435\u0440\u0430",
    mood: "\u042d\u043c\u043e\u0446\u0438\u044f",
    recognizedAt: "\u0420\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u043d\u043e",
    total: "\u0412\u0441\u0435\u0433\u043e",
    noImage: "\u041d\u0435\u0442 \u0441\u043d\u0438\u043c\u043a\u0430",
  },
  kz: {
    title: "\u0422\u04b1\u043b\u0493\u0430 \u043a\u0430\u0440\u0442\u0430\u0441\u044b",
    photos: "\u0421\u043e\u04a3\u0493\u044b 5 \u0441\u0443\u0440\u0435\u0442",
    notFound: "\u0422\u04b1\u043b\u0493\u0430 \u0442\u0430\u0431\u044b\u043b\u043c\u0430\u0434\u044b",
    loadError: "\u0416\u04af\u043a\u0442\u0435\u0443 \u049b\u0430\u0442\u0435\u0441\u0456",
    camera: "\u041a\u0430\u043c\u0435\u0440\u0430",
    mood: "\u042d\u043c\u043e\u0446\u0438\u044f",
    recognizedAt: "\u0422\u0430\u043d\u044b\u043b\u0493\u0430\u043d \u0443\u0430\u049b\u044b\u0442\u044b",
    total: "\u0411\u0430\u0440\u043b\u044b\u0493\u044b",
    noImage: "\u0421\u0443\u0440\u0435\u0442 \u0436\u043e\u049b",
  },
  en: {
    title: "Face Card",
    photos: "Last 5 images",
    notFound: "Face not found",
    loadError: "Load error",
    camera: "Camera",
    mood: "Mood",
    recognizedAt: "Recognized at",
    total: "Total",
    noImage: "No image",
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
  };
  images: FaceImage[];
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

  useEffect(() => {
    async function loadFace() {
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
    }
    void loadFace();
  }, [id, t.loadError, t.notFound]);

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
              <Tag>{`${t.total}: ${data.face.recognitionCount}`}</Tag>
            </div>

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
          </Space>
        </Card>
      )}
    </MainLayout>
  );
}
