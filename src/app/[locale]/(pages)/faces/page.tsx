"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Button, Card, Col, Empty, Popconfirm, Row, Space, Tag, Typography, message } from "antd";
import MainLayout from "@/components/layouts/MainLayout";

const { Text, Title } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "\u041b\u0438\u0446\u0430",
    subtitle: "\u0420\u0435\u0435\u0441\u0442\u0440 \u0440\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u043d\u043d\u044b\u0445 \u043b\u0438\u0446",
    noData: "\u041b\u0438\u0446\u0430 \u043f\u043e\u043a\u0430 \u043d\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u043d\u044b",
    noImage: "\u041d\u0435\u0442 \u0441\u043d\u0438\u043c\u043a\u0430",
    detections: "\u0420\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u0432\u0430\u043d\u0438\u0439",
    mood: "\u042d\u043c\u043e\u0446\u0438\u044f",
    open: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c",
    delete: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c",
    deleteConfirm: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043b\u0438\u0446\u043e?",
    deleteSuccess: "\u041b\u0438\u0446\u043e \u0443\u0434\u0430\u043b\u0435\u043d\u043e",
    deleteError: "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0443\u0434\u0430\u043b\u0438\u0442\u044c",
    loadError: "\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438",
    dedupJournal: "\u0416\u0443\u0440\u043d\u0430\u043b \u043c\u0430\u0442\u0447\u0438\u043d\u0433\u0430",
  },
  kz: {
    title: "\u0422\u04b1\u043b\u0493\u0430\u043b\u0430\u0440",
    subtitle: "\u0422\u0430\u043d\u044b\u043b\u0493\u0430\u043d \u0442\u04b1\u043b\u0493\u0430\u043b\u0430\u0440 \u0442\u0456\u0437\u0456\u043c\u0456",
    noData: "\u04d8\u0437\u0456\u0440\u0433\u0435 \u0441\u0430\u049b\u0442\u0430\u043b\u0493\u0430\u043d \u0442\u04b1\u043b\u0493\u0430\u043b\u0430\u0440 \u0436\u043e\u049b",
    noImage: "\u0421\u0443\u0440\u0435\u0442 \u0436\u043e\u049b",
    detections: "\u0422\u0430\u043d\u0443\u043b\u0430\u0440",
    mood: "\u042d\u043c\u043e\u0446\u0438\u044f",
    open: "\u0410\u0448\u0443",
    delete: "\u0416\u043e\u044e",
    deleteConfirm: "\u0422\u04b1\u043b\u0493\u0430\u043d\u044b \u0436\u043e\u044e \u043a\u0435\u0440\u0435\u043a \u043f\u0435?",
    deleteSuccess: "\u0422\u04b1\u043b\u0493\u0430 \u0436\u043e\u0439\u044b\u043b\u0434\u044b",
    deleteError: "\u0416\u043e\u044e \u0441\u04d9\u0442\u0441\u0456\u0437 \u0430\u044f\u049b\u0442\u0430\u043b\u0434\u044b",
    loadError: "\u0416\u04af\u043a\u0442\u0435\u0443 \u049b\u0430\u0442\u0435\u0441\u0456",
    dedupJournal: "\u041c\u0430\u0442\u0447\u0438\u043d\u0433 \u0436\u0443\u0440\u043d\u0430\u043b\u044b",
  },
  en: {
    title: "Faces",
    subtitle: "Recognized faces registry",
    noData: "No registered faces yet",
    noImage: "No image",
    detections: "Recognitions",
    mood: "Mood",
    open: "Open",
    delete: "Delete",
    deleteConfirm: "Delete this face?",
    deleteSuccess: "Face deleted",
    deleteError: "Delete failed",
    loadError: "Load error",
    dedupJournal: "Matching Journal",
  },
} as const;

type FaceCard = {
  id: string;
  shortId: string;
  recognitionCount: number;
  snapshotUrl: string;
  lastDetectedAt: string;
  lastMood?: string;
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

export default function FacesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [items, setItems] = useState<FaceCard[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string>("");

  const loadFaces = useCallback(async () => {
    try {
      const response = await fetch("/api/faces?limit=300", { cache: "no-store" });
      if (!response.ok) {
        setLoadError(`${t.loadError} (${response.status})`);
        return;
      }
      const payload = await response.json();
      setItems(Array.isArray(payload?.items) ? payload.items : []);
      setLoadError(null);
    } catch {
      setLoadError(t.loadError);
    }
  }, [t.loadError]);

  async function handleDelete(shortId: string) {
    setDeletingId(shortId);
    try {
      const response = await fetch(`/api/faces/${encodeURIComponent(shortId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        message.error(t.deleteError);
        return;
      }
      message.success(t.deleteSuccess);
      await loadFaces();
    } catch {
      message.error(t.deleteError);
    } finally {
      setDeletingId("");
    }
  }

  useEffect(() => {
    void loadFaces();
    const timer = setInterval(() => {
      void loadFaces();
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, [loadFaces]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <Card className="soft-card">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              {t.subtitle}
            </Title>
            <Space size={12} wrap>
              {loadError ? <Text type="danger">{loadError}</Text> : null}
              <Link href={`/${safeLocale}/matching-journal`}>
                <Button size="small">{t.dedupJournal}</Button>
              </Link>
            </Space>
          </div>

          {!items.length ? (
            <Empty description={t.noData} />
          ) : (
            <Row gutter={[16, 16]}>
              {items.map((item) => (
                <Col xs={24} sm={12} md={8} lg={6} key={item.id}>
                  <Card
                    hoverable
                    size="small"
                    cover={
                      item.snapshotUrl ? (
                        <img
                          src={item.snapshotUrl}
                          alt={item.shortId}
                          style={{ width: "100%", height: 190, objectFit: "cover" }}
                        />
                      ) : (
                        <div
                          style={{
                            width: "100%",
                            height: 190,
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
                    actions={[
                      <Link key="open" href={`/${safeLocale}/faces/${encodeURIComponent(item.shortId)}`}>
                        {t.open}
                      </Link>,
                      <Popconfirm
                        key="delete"
                        title={t.deleteConfirm}
                        okText="OK"
                        cancelText="Cancel"
                        onConfirm={() => handleDelete(item.shortId)}
                      >
                        <Button type="link" danger size="small" loading={deletingId === item.shortId}>
                          {t.delete}
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <Space direction="vertical" size={6} style={{ width: "100%" }}>
                      <Text strong>{item.shortId}</Text>
                      <Tag>{`${t.detections}: ${item.recognitionCount}`}</Tag>
                      {item.lastMood ? <Tag color="blue">{`${t.mood}: ${item.lastMood}`}</Tag> : null}
                      {item.lastDetectedAt ? (
                        <Text type="secondary">{formatDateTime(item.lastDetectedAt, safeLocale)}</Text>
                      ) : null}
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Space>
      </Card>
    </MainLayout>
  );
}
