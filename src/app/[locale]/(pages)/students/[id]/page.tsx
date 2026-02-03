"use client";

import { use, useEffect, useState } from "react";
import {
  Avatar,
  Card,
  Col,
  Empty,
  List,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  RiseOutlined,
  SmileOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";

const { Title, Text } = Typography;

type StudentStats = {
  totalRecognitions: number;
  positivePercent: number;
  neutralPercent: number;
  negativePercent: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  riskPercent: number;
  riskByRule: boolean;
  ruleText: string;
};

type StudentEvent = {
  id: string;
  mood: string;
  detectedAt: string;
};

type StudentPayload = {
  student: {
    id: string;
    name: string;
    firstLetter: string;
  };
  stats24h: StudentStats;
  dynamics: StudentEvent[];
  dynamicsPoints: Array<{
    bucketStart: string;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  }>;
  recent: StudentEvent[];
};

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
  if (
    normalized.includes("нег") ||
    normalized.includes("зл") ||
    normalized.includes("грус") ||
    normalized.includes("трев")
  ) {
    return "red";
  }
  if (normalized.includes("поз") || normalized.includes("рад") || normalized.includes("счаст")) {
    return "green";
  }
  return "blue";
}

export default function StudentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = use(params);
  const [data, setData] = useState<StudentPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadStudent() {
      try {
        const response = await fetch(`/api/students/${id}`, { cache: "no-store" });
        if (!response.ok) {
          if (active) {
            setLoadError(
              response.status === 404
                ? "Студент не найден в базе распознаваний"
                : `Ошибка загрузки (${response.status})`
            );
          }
          return;
        }

        const payload = await response.json();
        if (active) {
          setData(payload);
          setLoadError(null);
        }
      } catch {
        if (active) setLoadError("Ошибка соединения");
      }
    }

    loadStudent();
    const timer = setInterval(loadStudent, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);

  return (
    <MainLayout title="Профиль студента" locale={locale}>
      {loadError ? <Text type="danger">{loadError}</Text> : null}

      {!data ? (
        <Card className="soft-card" style={{ marginTop: 16 }}>
          <Empty description="Нет данных" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <Card className="soft-card">
              <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                <Avatar size={88}>{data.student.firstLetter}</Avatar>
                <div>
                  <Title level={4} style={{ marginBottom: 4 }}>
                    {data.student.name}
                  </Title>
                  <Text type="secondary">ID: {data.student.id}</Text>
                </div>
                <Text type="secondary">Фиксаций за 24 часа: {data.stats24h.totalRecognitions}</Text>
              </Space>
            </Card>

            <Card className="soft-card" style={{ marginTop: 16 }}>
              <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                <Title level={5} style={{ margin: 0 }}>
                  Риск
                </Title>
                <Progress
                  percent={data.stats24h.riskPercent}
                  status={data.stats24h.riskByRule ? "exception" : "normal"}
                />
                <Text type="secondary">{data.stats24h.ruleText}</Text>
              </Space>
            </Card>
          </Col>

          <Col xs={24} lg={16}>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={8}>
                <Card className="soft-card">
                  <Space orientation="vertical" size={8}>
                    <SmileOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">Позитив</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.positivePercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.positiveCount} фиксаций</Text>
                  </Space>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card className="soft-card">
                  <Space orientation="vertical" size={8}>
                    <RiseOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">Нейтрально</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.neutralPercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.neutralCount} фиксаций</Text>
                  </Space>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card className="soft-card">
                  <Space orientation="vertical" size={8}>
                    <WarningOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">Негатив</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.negativePercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.negativeCount} фиксаций</Text>
                  </Space>
                </Card>
              </Col>
            </Row>

            <Card
              title="Динамика всех фиксированных эмоций (24 часа)"
              style={{ marginTop: 16 }}
              className="soft-card"
            >
              <EmotionTimelineChart points={data.dynamicsPoints} />
            </Card>

            <Card
              title="Последние фиксации"
              style={{ marginTop: 16 }}
              className="soft-card"
            >
              <List
                dataSource={data.recent}
                locale={{ emptyText: "Нет данных" }}
                renderItem={(item) => (
                  <List.Item>
                    <Space>
                      <Text strong>{formatDateTime(item.detectedAt)}</Text>
                      <Tag color={moodColor(item.mood)}>{item.mood}</Tag>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          </Col>
        </Row>
      )}
    </MainLayout>
  );
}
