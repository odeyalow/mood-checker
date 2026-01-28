"use client";

import { use } from "react";
import {
  Card,
  Col,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
  Avatar,
} from "antd";
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

const { Title, Text } = Typography;

const recentEvents = [
  {
    name: "Алия Т.",
    mood: "Негатив",
    time: "2 мин назад",
  },
  {
    name: "Ержан К.",
    mood: "Нейтрально",
    time: "7 мин назад",
  },
  {
    name: "Мария Л.",
    mood: "Позитив",
    time: "11 мин назад",
  },
];

const alerts = [
  { room: "Аудитория 410", mood: "Тревога", time: "09:42" },
  { room: "Библиотека", mood: "Раздражение", time: "09:15" },
  { room: "Аудитория 203", mood: "Скука", time: "08:58" },
];

export default function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  return (
    <MainLayout title="Главный дэшборд" locale={locale}>
      <FaceScripts />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic title="Активные камеры" value={12} />
                <Text type="secondary">+2 за неделю</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic
                  title="Распознаваний"
                  value={128}
                  prefix={<ArrowUpOutlined />}
                />
                <Text type="secondary">Сегодня</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic
                  title="Негатив"
                  value={18}
                  suffix="%"
                  styles={{ content: { color: "#dc2626" } }}
                />
                <Text type="secondary">-3% с прошлой недели</Text>
              </Card>
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Card className="soft-card">
                <Statistic
                  title="Зона риска"
                  value={7}
                  prefix={<ArrowDownOutlined />}
                />
                <Text type="secondary">Студентов</Text>
              </Card>
            </Col>
          </Row>

          <Card title="Камеры" style={{ marginTop: 16 }} className="soft-card">
            <CameraGrid />
          </Card>

          <Card
            title="Динамика эмоций"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <div className="chart-placeholder">График распределения эмоций</div>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="Последние распознавания" className="soft-card">
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
              {recentEvents.map((item) => (
                <div
                  key={item.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <Space>
                    <Avatar>{item.name[0]}</Avatar>
                    <div>
                      <Text strong>{item.name}</Text>
                      <div>
                        <Text type="secondary">{item.time}</Text>
                      </div>
                    </div>
                  </Space>
                  <Tag color={item.mood === "Негатив" ? "red" : "blue"}>
                    {item.mood}
                  </Tag>
                </div>
              ))}
            </Space>
          </Card>

          <Card
            title="Негативные события"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              {alerts.map((item) => (
                <div
                  key={`${item.room}-${item.time}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div>
                    <Text strong>{item.room}</Text>
                    <div>
                      <Text type="secondary">{item.time}</Text>
                    </div>
                  </div>
                  <Tag color="red">{item.mood}</Tag>
                </div>
              ))}
            </Space>
          </Card>

          <Card
            title="Распределение настроений"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              <div>
                <Text>Позитив</Text>
                <Progress percent={42} showInfo={false} />
              </div>
              <div>
                <Text>Нейтрально</Text>
                <Progress percent={36} showInfo={false} />
              </div>
              <div>
                <Text>Негатив</Text>
                <Progress percent={22} showInfo={false} status="exception" />
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </MainLayout>
  );
}
