"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import dayjs, { Dayjs } from "dayjs";
import {
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Typography,
} from "antd";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";
import MainLayout from "@/components/layouts/MainLayout";

const { Text } = Typography;
const { RangePicker } = DatePicker;

type Preset = "2" | "3" | "5" | "custom";

type DateStatsResponse = {
  stats: {
    riskCount: number;
    negativePercent: number;
    recognitionsCount: number;
  };
  points: Array<{
    bucketStart: string;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  }>;
  students: Array<{
    id: string;
    name: string;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
    riskScore: number;
  }>;
};

export default function ByDatePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const [preset, setPreset] = useState<Preset>("2");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DateStatsResponse | null>(null);

  async function loadStats() {
    setLoading(true);
    setError(null);

    try {
      let query = "";
      if (preset === "custom") {
        if (!range) {
          setError("Выберите даты для пользовательского диапазона.");
          return;
        }
        query = `from=${encodeURIComponent(range[0].toISOString())}&to=${encodeURIComponent(range[1].toISOString())}`;
      } else {
        query = `days=${preset}`;
      }

      const response = await fetch(`/api/stats/by-date?${query}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setError(`Ошибка загрузки (${response.status}).`);
        return;
      }
      const payload = (await response.json()) as DateStatsResponse;
      setData(payload);
    } catch {
      setError("Ошибка соединения.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MainLayout title="По дате" locale={locale}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card className="soft-card">
          <Space wrap>
            <Select<Preset>
              value={preset}
              style={{ width: 220 }}
              onChange={(value) => setPreset(value)}
              options={[
                { value: "2", label: "Последние 2 дня" },
                { value: "3", label: "Последние 3 дня" },
                { value: "5", label: "Последние 5 дней" },
                { value: "custom", label: "Свой диапазон" },
              ]}
            />
            <RangePicker
              showTime
              disabled={preset !== "custom"}
              value={range}
              onChange={(values) =>
                setRange(values && values[0] && values[1] ? [values[0], values[1]] : null)
              }
            />
            <Button type="primary" loading={loading} onClick={() => void loadStats()}>
              Получить статистику
            </Button>
          </Space>
          {error ? (
            <div style={{ marginTop: 12 }}>
              <Text type="danger">{error}</Text>
            </div>
          ) : null}
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title="Риск" value={data?.stats.riskCount ?? 0} />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title="Процент негатива" value={data?.stats.negativePercent ?? 0} suffix="%" />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title="Распознаваний за период" value={data?.stats.recognitionsCount ?? 0} />
            </Card>
          </Col>
        </Row>

        <Card title="График динамики эмоций" className="soft-card">
          <EmotionTimelineChart points={data?.points ?? []} />
        </Card>

        <Card title="Студенты с приоритетом негативных и нейтральных эмоций (топ 20)" className="soft-card">
          <Table
            rowKey="id"
            dataSource={data?.students ?? []}
            pagination={false}
            columns={[
              {
                title: "Студент",
                dataIndex: "name",
                render: (_value: string, row: DateStatsResponse["students"][number]) => (
                  <Link href={`/${locale}/students/${row.id}`}>{row.name}</Link>
                ),
              },
              {
                title: "Негатив",
                dataIndex: "negativeCount",
              },
              {
                title: "Нейтрально",
                dataIndex: "neutralCount",
              },
              {
                title: "Позитив",
                dataIndex: "positiveCount",
              },
              {
                title: "Риск-оценка",
                dataIndex: "riskScore",
              },
            ]}
          />
        </Card>
      </Space>
    </MainLayout>
  );
}
