"use client";

import { use } from "react";
import { Card, Table, Tag, Typography, Space, Progress } from "antd";
import { TrophyOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";

const { Title, Text } = Typography;

const dataSource = [
  {
    key: "1",
    rank: 1,
    name: "Айсулу Ж.",
    group: "CS-21",
    negativeRate: 62,
    lastMood: "Тревога",
    lastSeen: "Сегодня, 10:12",
  },
  {
    key: "2",
    rank: 2,
    name: "Нуржан К.",
    group: "IT-19",
    negativeRate: 58,
    lastMood: "Раздражение",
    lastSeen: "Сегодня, 09:47",
  },
  {
    key: "3",
    rank: 3,
    name: "Мария С.",
    group: "SE-22",
    negativeRate: 54,
    lastMood: "Скука",
    lastSeen: "Вчера, 16:21",
  },
];

export default function TopNegativePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  return (
    <MainLayout title="Топ негативных" locale={locale}>
      <Card className="soft-card">
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              <TrophyOutlined /> Лидерборд по негативным эмоциям
            </Title>
            <Text type="secondary">
              Студенты с наиболее частыми негативными реакциями за 7 дней.
            </Text>
          </div>
          <Table
            dataSource={dataSource}
            pagination={false}
            columns={[
              {
                title: "Ранг",
                dataIndex: "rank",
                width: 80,
              },
              {
                title: "Студент",
                dataIndex: "name",
              },
              {
                title: "Группа",
                dataIndex: "group",
              },
              {
                title: "Негатив",
                dataIndex: "negativeRate",
                render: (value: number) => (
                  <Progress percent={value} showInfo={false} status="exception" />
                ),
              },
              {
                title: "Последнее настроение",
                dataIndex: "lastMood",
                render: (value: string) => <Tag color="red">{value}</Tag>,
              },
              {
                title: "Последняя фиксация",
                dataIndex: "lastSeen",
              },
            ]}
          />
        </Space>
      </Card>
    </MainLayout>
  );
}
