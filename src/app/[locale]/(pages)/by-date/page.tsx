"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import type { Dayjs } from "dayjs";
import { Button, Card, Col, DatePicker, Row, Select, Space, Statistic, Table, Typography } from "antd";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";
import MainLayout from "@/components/layouts/MainLayout";

const { Text } = Typography;
const { RangePicker } = DatePicker;

type AppLocale = "ru" | "kz" | "en";
type Preset = "all" | "30" | "90" | "custom";

const L10N = {
  ru: {
    pageTitle: "По дате",
    getStats: "Получить статистику",
    selectDatesError: "Выберите даты для пользовательского диапазона.",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения.",
    risk: "Риск",
    negativePercent: "Процент негатива",
    recognitions: "Распознаваний за период",
    chartTitle: "График динамики эмоций",
    tableTitle: "Студенты с приоритетом негативных и нейтральных эмоций (топ 20)",
    rangeHint: "По умолчанию показывается вся история. Можно выбрать любой диапазон дат.",
    student: "Студент",
    negative: "Негатив",
    neutral: "Нейтрально",
    positive: "Позитив",
    riskScore: "Риск-оценка",
    presets: {
      all: "Все время",
      d30: "Последние 30 дней",
      d90: "Последние 90 дней",
      custom: "Свой диапазон",
    },
  },
  kz: {
    pageTitle: "Күні бойынша",
    getStats: "Статистиканы алу",
    selectDatesError: "Қолданушы аралығы үшін күндерді таңдаңыз.",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі.",
    risk: "Тәуекел",
    negativePercent: "Негатив пайызы",
    recognitions: "Кезең ішіндегі танулар",
    chartTitle: "Эмоция динамикасының графигі",
    tableTitle: "Негатив және нейтрал эмоция басым студенттер (топ 20)",
    rangeHint: "Әдепкіде бүкіл тарих көрсетіледі. Кез келген күн аралығын таңдауға болады.",
    student: "Студент",
    negative: "Негатив",
    neutral: "Нейтрал",
    positive: "Позитив",
    riskScore: "Тәуекел ұпайы",
    presets: {
      all: "Барлық уақыт",
      d30: "Соңғы 30 күн",
      d90: "Соңғы 90 күн",
      custom: "Өз аралығы",
    },
  },
  en: {
    pageTitle: "By Date",
    getStats: "Load stats",
    selectDatesError: "Select dates for custom range.",
    loadError: "Load error",
    connectionError: "Connection error.",
    risk: "Risk",
    negativePercent: "Negative percent",
    recognitions: "Recognitions in range",
    chartTitle: "Emotion Dynamics Chart",
    tableTitle: "Students with priority of negative and neutral emotions (top 20)",
    rangeHint: "By default the full history is shown. You can also select any custom date range.",
    student: "Student",
    negative: "Negative",
    neutral: "Neutral",
    positive: "Positive",
    riskScore: "Risk score",
    presets: {
      all: "All time",
      d30: "Last 30 days",
      d90: "Last 90 days",
      custom: "Custom range",
    },
  },
} as const;

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
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];

  const [preset, setPreset] = useState<Preset>("all");
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
          setError(t.selectDatesError);
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
        setError(`${t.loadError} (${response.status}).`);
        return;
      }
      const payload = (await response.json()) as DateStatsResponse;
      setData(payload);
    } catch {
      setError(t.connectionError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadStats();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MainLayout title={t.pageTitle} locale={safeLocale}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card className="soft-card">
          <Space wrap>
            <Select<Preset>
              value={preset}
              style={{ width: 220 }}
              onChange={(value) => setPreset(value)}
              options={[
                { value: "all", label: t.presets.all },
                { value: "30", label: t.presets.d30 },
                { value: "90", label: t.presets.d90 },
                { value: "custom", label: t.presets.custom },
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
              {t.getStats}
            </Button>
          </Space>
          {error ? (
            <div style={{ marginTop: 12 }}>
              <Text type="danger">{error}</Text>
            </div>
          ) : null}
          {!error ? (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary">{t.rangeHint}</Text>
            </div>
          ) : null}
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title={t.risk} value={data?.stats.riskCount ?? 0} />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title={t.negativePercent} value={data?.stats.negativePercent ?? 0} suffix="%" />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card className="soft-card">
              <Statistic title={t.recognitions} value={data?.stats.recognitionsCount ?? 0} />
            </Card>
          </Col>
        </Row>

        <Card title={t.chartTitle} className="soft-card">
          <EmotionTimelineChart points={data?.points ?? []} locale={safeLocale} />
        </Card>

        <Card title={t.tableTitle} className="soft-card">
          <Table
            rowKey="id"
            dataSource={data?.students ?? []}
            pagination={false}
            columns={[
              {
                title: t.student,
                dataIndex: "name",
                render: (_value: string, row: DateStatsResponse["students"][number]) => (
                  <Link href={`/${safeLocale}/students/${encodeURIComponent(row.id)}`}>{row.name}</Link>
                ),
              },
              {
                title: t.negative,
                dataIndex: "negativeCount",
              },
              {
                title: t.neutral,
                dataIndex: "neutralCount",
              },
              {
                title: t.positive,
                dataIndex: "positiveCount",
              },
              {
                title: t.riskScore,
                dataIndex: "riskScore",
              },
            ]}
          />
        </Card>
      </Space>
    </MainLayout>
  );
}
