"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Button, Card, Col, Empty, Row, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";

const { Text } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Детали матчинга",
    back: "Назад к журналу",
    deleted: "Удалено",
    reason: "Причина",
    from: "Фото при регистрации",
    to: "Фото существующего лица",
    sourceId: "Новый ID",
    targetId: "Существующий ID",
    distance: "Дистанция",
    threshold: "Порог",
    noImage: "Нет снимка",
    notFound: "Событие не найдено",
  },
  kz: {
    title: "Матчинг деректері",
    back: "Журналға қайту",
    deleted: "Жойылды",
    reason: "Себеп",
    from: "Тіркеу кезіндегі фото",
    to: "Базадағы бар фото",
    sourceId: "Жаңа ID",
    targetId: "Бар ID",
    distance: "Қашықтық",
    threshold: "Шек",
    noImage: "Сурет жоқ",
    notFound: "Оқиға табылмады",
  },
  en: {
    title: "Matching Details",
    back: "Back to journal",
    deleted: "Deleted",
    reason: "Reason",
    from: "Photo at registration",
    to: "Existing face photo",
    sourceId: "New ID",
    targetId: "Existing ID",
    distance: "Distance",
    threshold: "Threshold",
    noImage: "No image",
    notFound: "Event not found",
  },
} as const;

type DedupLogItem = {
  id: string;
  action: string;
  reason: string;
  sourceFaceId: string | null;
  sourceShortId: string | null;
  sourceSnapshotUrl: string | null;
  targetFaceId: string | null;
  targetShortId: string | null;
  targetSnapshotUrl: string | null;
  distance: number | null;
  threshold: number | null;
  createdAt: string;
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

function SnapshotCard({
  title,
  url,
  noImage,
}: {
  title: string;
  url: string | null;
  noImage: string;
}) {
  return (
    <Card title={title} size="small">
      {url ? (
        <Image
          src={url}
          alt={title}
          width={960}
          height={540}
          style={{ width: "100%", maxHeight: 360, objectFit: "contain", background: "#fafafa" }}
        />
      ) : (
        <Empty description={noImage} />
      )}
    </Card>
  );
}

export default function FaceDedupJournalDetailsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [item, setItem] = useState<DedupLogItem | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const response = await fetch(`/api/faces/dedup-logs/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        if (mounted) setItem(null);
        return;
      }
      const payload = await response.json();
      if (mounted) setItem(payload?.item || null);
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Link href={`/${safeLocale}/matching-journal`}>
          <Button>{t.back}</Button>
        </Link>

        {!item ? (
          <Card>
            <Empty description={t.notFound} />
          </Card>
        ) : (
          <Card>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Space wrap>
                <Tag color="red">{t.deleted}</Tag>
                <Text type="secondary">{formatDateTime(item.createdAt, safeLocale)}</Text>
              </Space>
              <Text>{`${t.reason}: ${item.reason}`}</Text>
              <Text>{`${t.sourceId}: ${item.sourceShortId || "-"}`}</Text>
              <Text>{`${t.targetId}: ${item.targetShortId || "-"}`}</Text>
              <Text type="secondary">{`${t.distance}: ${Number(item.distance ?? 0).toFixed(6)}`}</Text>
              <Text type="secondary">{`${t.threshold}: ${Number(item.threshold ?? 0).toFixed(6)}`}</Text>
            </Space>
          </Card>
        )}

        {item ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <SnapshotCard title={t.from} url={item.sourceSnapshotUrl} noImage={t.noImage} />
            </Col>
            <Col xs={24} md={12}>
              <SnapshotCard title={t.to} url={item.targetSnapshotUrl} noImage={t.noImage} />
            </Col>
          </Row>
        ) : null}
      </Space>
    </MainLayout>
  );
}
