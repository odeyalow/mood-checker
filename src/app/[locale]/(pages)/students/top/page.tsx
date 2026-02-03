"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Card, Table, Tag, Typography, Space, Progress } from "antd";
import { TrophyOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";

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

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function moodColor(mood: string) {
  const normalized = mood.toLowerCase();
  if (normalized.includes("нег") || normalized.includes("зл") || normalized.includes("грус")) {
    return "red";
  }
  if (normalized.includes("поз") || normalized.includes("рад") || normalized.includes("счаст")) {
    return "green";
  }
  return "blue";
}

export default function TopNegativePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
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
          if (active) setLoadError(`Ошибка загрузки (${response.status})`);
          return;
        }

        const data = await response.json();
        if (active) {
          setItems(Array.isArray(data.items) ? data.items : []);
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError("Ошибка соединения");
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
    <MainLayout title="Топ негативных" locale={locale}>
      <Card className="soft-card">
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              <TrophyOutlined /> Лидерборд по риску за 24 часа
            </Title>
            <Text type="secondary">
              Риск = негативные эмоции + превышение нейтральных над позитивными.
            </Text>
          </div>

          {loadError ? <Text type="danger">{loadError}</Text> : null}

          <Table
            rowKey="id"
            dataSource={items}
            pagination={{ pageSize: 20 }}
            columns={[
              {
                title: "Ранг",
                dataIndex: "rank",
                width: 80,
              },
              {
                title: "Студент",
                dataIndex: "name",
                render: (_value: string, row: LeaderboardItem) => (
                  <Link href={`/${locale}/students/${row.id}`}>{row.name}</Link>
                ),
              },
              {
                title: "Риск",
                dataIndex: "riskPercent",
                render: (value: number) => (
                  <Progress percent={value} showInfo={false} status="exception" />
                ),
              },
              {
                title: "Последняя эмоция",
                dataIndex: "lastMood",
                render: (value: string) => <Tag color={moodColor(value)}>{value}</Tag>,
              },
              {
                title: "Последняя фиксация",
                dataIndex: "lastDetectedAt",
                render: (value: string) => formatDateTime(value),
              },
            ]}
          />
        </Space>
      </Card>
    </MainLayout>
  );
}
