"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Card, Table, Tag, Typography, Space, Progress } from "antd";
import { TrophyOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";
import { classifyMood } from "@/lib/mood";

type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Топ негативных",
    boardTitle: "Лидерборд по риску за 24 часа",
    boardHint: "Риск = негативные эмоции + превышение нейтральных над позитивными.",
    rank: "Ранг",
    student: "Студент",
    risk: "Риск",
    lastMood: "Последняя эмоция",
    lastDetectedAt: "Последняя фиксация",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения",
  },
  kz: {
    title: "Негатив топ",
    boardTitle: "24 сағаттағы тәуекел лидерборды",
    boardHint: "Тәуекел = негатив эмоция + нейтралдың позитивтен артуы.",
    rank: "Орын",
    student: "Студент",
    risk: "Тәуекел",
    lastMood: "Соңғы эмоция",
    lastDetectedAt: "Соңғы фиксация",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі",
  },
  en: {
    title: "Top Negative",
    boardTitle: "Risk leaderboard for last 24 hours",
    boardHint: "Risk = negative emotions + neutral exceeding positive.",
    rank: "Rank",
    student: "Student",
    risk: "Risk",
    lastMood: "Last Mood",
    lastDetectedAt: "Last Detection",
    loadError: "Load error",
    connectionError: "Connection error",
  },
} as const;

type LeaderboardItem = {
  rank: number;
  id: string;
  name: string;
  riskPercent: number;
  lastMood: string;
  lastDetectedAt: string;
  totals: {
    positive: number;
    neutral: number;
    negative: number;
  };
};

const { Title, Text } = Typography;

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

function moodColor(mood: string) {
  const kind = classifyMood(mood);
  if (kind === "negative") return "red";
  if (kind === "positive") return "green";
  return "blue";
}

export default function TopNegativePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];
  const [items, setItems] = useState<LeaderboardItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const response = await fetch("/api/students/leaderboard?limit=50", {
          cache: "no-store",
        });
        if (!response.ok) {
          if (active) setLoadError(`${t.loadError} (${response.status})`);
          return;
        }

        const data = await response.json();
        if (active) {
          setItems(Array.isArray(data.items) ? data.items : []);
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError(t.connectionError);
      }
    }

    loadData();
    const timer = setInterval(loadData, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <Card className="soft-card">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              <TrophyOutlined /> {t.boardTitle}
            </Title>
            <Text type="secondary">{t.boardHint}</Text>
          </div>

          {loadError ? <Text type="danger">{loadError}</Text> : null}

          <Table
            rowKey="id"
            dataSource={items}
            pagination={{ pageSize: 20 }}
            columns={[
              {
                title: t.rank,
                dataIndex: "rank",
                width: 80,
              },
              {
                title: t.student,
                dataIndex: "name",
                render: (_value: string, row: LeaderboardItem) => (
                  <Link href={`/${safeLocale}/students/${row.id}`}>{row.name}</Link>
                ),
              },
              {
                title: t.risk,
                dataIndex: "riskPercent",
                render: (value: number) => (
                  <Progress percent={value} showInfo={false} status="exception" />
                ),
              },
              {
                title: t.lastMood,
                dataIndex: "lastMood",
                render: (value: string) => <Tag color={moodColor(value)}>{value}</Tag>,
              },
              {
                title: t.lastDetectedAt,
                dataIndex: "lastDetectedAt",
                render: (value: string) => formatDateTime(value, safeLocale),
              },
            ]}
          />
        </Space>
      </Card>
    </MainLayout>
  );
}
