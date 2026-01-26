"use client";

import { use } from "react";
import {
  Avatar,
  Card,
  Col,
  Descriptions,
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

const { Title, Text } = Typography;

const moodHistory = [
  { date: "23.01", mood: "Нейтрально", moodColor: "blue" },
  { date: "24.01", mood: "Позитив", moodColor: "green" },
  { date: "25.01", mood: "Скука", moodColor: "gold" },
  { date: "26.01", mood: "Тревога", moodColor: "red" },
];

export default function StudentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = use(params);
  return (
    <MainLayout title="Профиль студента" locale={locale}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card className="soft-card">
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
              <Avatar size={88}>А</Avatar>
              <div>
                <Title level={4} style={{ marginBottom: 4 }}>
                  Айсулу Ж.
                </Title>
                <Text type="secondary">ID: {id}</Text>
              </div>
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="Группа">CS-21</Descriptions.Item>
                <Descriptions.Item label="Кафедра">
                  Computer Science
                </Descriptions.Item>
                <Descriptions.Item label="Статус">
                  <Tag color="green">Активен</Tag>
                </Descriptions.Item>
              </Descriptions>
            </Space>
          </Card>

          <Card className="soft-card" style={{ marginTop: 16 }}>
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              <Title level={5} style={{ margin: 0 }}>
                Риск негативных эмоций
              </Title>
              <Progress percent={58} status="exception" />
              <Text type="secondary">
                7 негативных фиксаций за последние 30 дней.
              </Text>
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
                    24%
                  </Title>
                </Space>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card className="soft-card">
                <Space orientation="vertical" size={8}>
                  <RiseOutlined style={{ fontSize: 22 }} />
                  <Text type="secondary">Нейтрально</Text>
                  <Title level={3} style={{ margin: 0 }}>
                    41%
                  </Title>
                </Space>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card className="soft-card">
                <Space orientation="vertical" size={8}>
                  <WarningOutlined style={{ fontSize: 22 }} />
                  <Text type="secondary">Негатив</Text>
                  <Title level={3} style={{ margin: 0 }}>
                    35%
                  </Title>
                </Space>
              </Card>
            </Col>
          </Row>

          <Card
            title="График изменения настроений"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <div className="chart-placeholder">
              Линия настроений по выбранным датам
            </div>
          </Card>

          <Card
            title="Последние фиксации"
            style={{ marginTop: 16 }}
            className="soft-card"
          >
            <List
              dataSource={moodHistory}
              renderItem={(item) => (
                <List.Item>
                  <Space>
                    <Text strong>{item.date}</Text>
                    <Tag color={item.moodColor}>{item.mood}</Tag>
                  </Space>
                  <Text type="secondary">Аудитория 203</Text>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </MainLayout>
  );
}
