"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Card, Empty, List, Space, Tag, Typography } from "antd";
import MainLayout from "@/components/layouts/MainLayout";

const { Text, Title } = Typography;

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Журнал матчинга",
    subtitle: "События дедупликации и удаления дублей",
    noData: "Событий пока нет",
    open: "Открыть",
    deleted: "Удалено",
    from: "Новое лицо",
    to: "Совпало с",
    distance: "Дистанция",
    threshold: "Порог",
  },
  kz: {
    title: "Матчинг журналы",
    subtitle: "Дубликаттарды жою және сәйкестік оқиғалары",
    noData: "Оқиғалар әлі жоқ",
    open: "Ашу",
    deleted: "Жойылды",
    from: "Жаңа тұлға",
    to: "Сәйкес келген",
    distance: "Қашықтық",
    threshold: "Шек",
  },
  en: {
    title: "Matching Journal",
    subtitle: "Deduplication and duplicate removal events",
    noData: "No events yet",
    open: "Open",
    deleted: "Deleted",
    from: "New face",
    to: "Matched with",
    distance: "Distance",
    threshold: "Threshold",
  },
} as const;

type DedupItem = {
  id: string;
  action: string;
  reason: string;
  sourceShortId: string | null;
  targetShortId: string | null;
  sourceSnapshotUrl: string | null;
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

export default function FaceDedupJournalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [items, setItems] = useState<DedupItem[]>([]);

  const loadItems = useCallback(async () => {
    const response = await fetch("/api/faces/dedup-logs?limit=200", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setItems(Array.isArray(payload?.items) ? payload.items : []);
  }, []);

  useEffect(() => {
    const initialTimer = setTimeout(() => {
      void loadItems();
    }, 0);
    const timer = setInterval(() => {
      void loadItems();
    }, 10_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(timer);
    };
  }, [loadItems]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <Card className="soft-card">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Title level={4} style={{ margin: 0 }}>
            {t.subtitle}
          </Title>

          {!items.length ? (
            <Empty description={t.noData} />
          ) : (
            <List
              itemLayout="vertical"
              dataSource={items}
              renderItem={(item) => (
                <List.Item
                  key={item.id}
                  actions={[
                    <Link key="open" href={`/${safeLocale}/faces/dedup/${encodeURIComponent(item.id)}`}>
                      {t.open}
                    </Link>,
                  ]}
                >
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Space wrap>
                      <Tag color="red">{t.deleted}</Tag>
                      <Text type="secondary">{formatDateTime(item.createdAt, safeLocale)}</Text>
                    </Space>
                    <Text>{item.reason}</Text>
                    <Text>{`${t.from}: ${item.sourceShortId || "-"}`}</Text>
                    <Text>{`${t.to}: ${item.targetShortId || "-"}`}</Text>
                    <Text type="secondary">{`${t.distance}: ${Number(item.distance ?? 0).toFixed(4)}`}</Text>
                    <Text type="secondary">{`${t.threshold}: ${Number(item.threshold ?? 0).toFixed(4)}`}</Text>
                  </Space>
                </List.Item>
              )}
            />
          )}
        </Space>
      </Card>
    </MainLayout>
  );
}
