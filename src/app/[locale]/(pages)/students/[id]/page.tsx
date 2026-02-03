"use client";

import { use, useEffect, useState } from "react";
import type { Dayjs } from "dayjs";
import {
  Avatar,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  List,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { RiseOutlined, SmileOutlined, WarningOutlined } from "@ant-design/icons";
import MainLayout from "@/components/layouts/MainLayout";
import EmotionTimelineChart from "@/components/dashboard/EmotionTimelineChart";
import { classifyMood } from "@/lib/mood";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

type Preset = "2" | "3" | "5" | "custom";
type AppLocale = "ru" | "kz" | "en";

const L10N = {
  ru: {
    title: "Профиль студента",
    notFound: "Студент не найден в базе распознаваний",
    loadError: "Ошибка загрузки",
    connectionError: "Ошибка соединения",
    noData: "Нет данных",
    in24h: "Фиксаций за 24 часа",
    risk: "Риск",
    positive: "Позитив",
    neutral: "Нейтрально",
    negative: "Негатив",
    entries: "фиксаций",
    dynamics24h: "Динамика эмоций (24 часа)",
    recentRecognitions: "Последние фиксации",
    statsByDate: "Статистика по дате (этот студент)",
    last2Days: "Последние 2 дня",
    last3Days: "Последние 3 дня",
    last5Days: "Последние 5 дней",
    custom: "Свой диапазон",
    loadStats: "Получить статистику",
    selectCustomRange: "Выберите даты для пользовательского диапазона.",
    statsLoadError: "Ошибка загрузки статистики",
    negativePercent: "Процент негатива",
    recognitionsInRange: "Распознаваний за период",
    recentInRange: "Последние фиксации за выбранный период",
  },
  kz: {
    title: "Студент профилі",
    notFound: "Студент тану базасында табылмады",
    loadError: "Жүктеу қатесі",
    connectionError: "Байланыс қатесі",
    noData: "Дерек жоқ",
    in24h: "24 сағаттағы фиксациялар",
    risk: "Тәуекел",
    positive: "Позитив",
    neutral: "Нейтрал",
    negative: "Негатив",
    entries: "фиксация",
    dynamics24h: "Эмоция динамикасы (24 сағат)",
    recentRecognitions: "Соңғы фиксациялар",
    statsByDate: "Күні бойынша статистика (осы студент)",
    last2Days: "Соңғы 2 күн",
    last3Days: "Соңғы 3 күн",
    last5Days: "Соңғы 5 күн",
    custom: "Өз аралығы",
    loadStats: "Статистиканы алу",
    selectCustomRange: "Қолданушы аралығы үшін күндерді таңдаңыз.",
    statsLoadError: "Статистика жүктеу қатесі",
    negativePercent: "Негатив пайызы",
    recognitionsInRange: "Кезең ішіндегі танулар",
    recentInRange: "Таңдалған кезеңдегі соңғы фиксациялар",
  },
  en: {
    title: "Student Profile",
    notFound: "Student not found in recognitions database",
    loadError: "Load error",
    connectionError: "Connection error",
    noData: "No data",
    in24h: "Recognitions in 24h",
    risk: "Risk",
    positive: "Positive",
    neutral: "Neutral",
    negative: "Negative",
    entries: "entries",
    dynamics24h: "Emotion dynamics (24h)",
    recentRecognitions: "Recent recognitions",
    statsByDate: "Stats by date (student)",
    last2Days: "Last 2 days",
    last3Days: "Last 3 days",
    last5Days: "Last 5 days",
    custom: "Custom range",
    loadStats: "Load stats",
    selectCustomRange: "Select dates for custom range.",
    statsLoadError: "Stats load error",
    negativePercent: "Negative percent",
    recognitionsInRange: "Recognitions in range",
    recentInRange: "Recent recognitions in selected range",
  },
} as const;

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

type StudentDateStatsPayload = {
  stats: {
    riskCount: number;
    riskByRule: boolean;
    riskScore: number;
    negativePercent: number;
    recognitionsCount: number;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  };
  points: Array<{
    bucketStart: string;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  }>;
  recent: StudentEvent[];
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

function moodColor(mood: string) {
  const kind = classifyMood(mood);
  if (kind === "negative") return "red";
  if (kind === "positive") return "green";
  return "blue";
}

export default function StudentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = use(params);
  const safeLocale: AppLocale = locale === "kz" || locale === "en" ? locale : "ru";
  const t = L10N[safeLocale];
  const [data, setData] = useState<StudentPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("2");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [dateStatsLoading, setDateStatsLoading] = useState(false);
  const [dateStatsError, setDateStatsError] = useState<string | null>(null);
  const [dateStats, setDateStats] = useState<StudentDateStatsPayload | null>(null);

  useEffect(() => {
    let active = true;

    async function loadStudent() {
      try {
        const response = await fetch(`/api/students/${id}`, { cache: "no-store" });
        if (!response.ok) {
          if (active) {
            setLoadError(
              response.status === 404
                ? t.notFound
                : `${t.loadError} (${response.status})`
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
        if (active) setLoadError(t.connectionError);
      }
    }

    void loadStudent();
    const timer = setInterval(loadStudent, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, t.connectionError, t.loadError, t.notFound]);

  async function loadDateStats() {
    setDateStatsLoading(true);
    setDateStatsError(null);

    try {
      let query = "";
      if (preset === "custom") {
        if (!range) {
          setDateStatsError(t.selectCustomRange);
          return;
        }
        query = `from=${encodeURIComponent(range[0].toISOString())}&to=${encodeURIComponent(range[1].toISOString())}`;
      } else {
        query = `days=${preset}`;
      }

      const response = await fetch(`/api/students/${id}/by-date?${query}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setDateStatsError(`${t.statsLoadError} (${response.status}).`);
        return;
      }

      const payload = (await response.json()) as StudentDateStatsPayload;
      setDateStats(payload);
    } catch {
      setDateStatsError(t.connectionError);
    } finally {
      setDateStatsLoading(false);
    }
  }

  useEffect(() => {
    void loadDateStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, t.connectionError, t.selectCustomRange, t.statsLoadError]);

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      {loadError ? <Text type="danger">{loadError}</Text> : null}

      {!data ? (
        <Card className="soft-card" style={{ marginTop: 16 }}>
          <Empty description={t.noData} />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <Card className="soft-card">
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Avatar size={88}>{data.student.firstLetter}</Avatar>
                <div>
                  <Title level={4} style={{ marginBottom: 4 }}>
                    {data.student.name}
                  </Title>
                  <Text type="secondary">ID: {data.student.id}</Text>
                </div>
                <Text type="secondary">{t.in24h}: {data.stats24h.totalRecognitions}</Text>
              </Space>
            </Card>

            <Card className="soft-card" style={{ marginTop: 16 }}>
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Title level={5} style={{ margin: 0 }}>
                  {t.risk}
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
                  <Space direction="vertical" size={8}>
                    <SmileOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">{t.positive}</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.positivePercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.positiveCount} {t.entries}</Text>
                  </Space>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card className="soft-card">
                  <Space direction="vertical" size={8}>
                    <RiseOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">{t.neutral}</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.neutralPercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.neutralCount} {t.entries}</Text>
                  </Space>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card className="soft-card">
                  <Space direction="vertical" size={8}>
                    <WarningOutlined style={{ fontSize: 22 }} />
                    <Text type="secondary">{t.negative}</Text>
                    <Title level={3} style={{ margin: 0 }}>
                      {data.stats24h.negativePercent}%
                    </Title>
                    <Text type="secondary">{data.stats24h.negativeCount} {t.entries}</Text>
                  </Space>
                </Card>
              </Col>
            </Row>

            <Card title={t.dynamics24h} style={{ marginTop: 16 }} className="soft-card">
              <EmotionTimelineChart points={data.dynamicsPoints} locale={safeLocale} />
            </Card>

            <Card title={t.recentRecognitions} style={{ marginTop: 16 }} className="soft-card">
              <List
                dataSource={data.recent}
                locale={{ emptyText: t.noData }}
                renderItem={(item) => (
                  <List.Item>
                    <Space>
                      <Text strong>{formatDateTime(item.detectedAt, safeLocale)}</Text>
                      <Tag color={moodColor(item.mood)}>{item.mood}</Tag>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>

            <Card title={t.statsByDate} style={{ marginTop: 16 }} className="soft-card">
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Space wrap>
                  <Select<Preset>
                    value={preset}
                    style={{ width: 220 }}
                    onChange={(value) => setPreset(value)}
                    options={[
                      { value: "2", label: t.last2Days },
                      { value: "3", label: t.last3Days },
                      { value: "5", label: t.last5Days },
                      { value: "custom", label: t.custom },
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
                  <Button type="primary" loading={dateStatsLoading} onClick={() => void loadDateStats()}>
                    {t.loadStats}
                  </Button>
                </Space>

                {dateStatsError ? <Text type="danger">{dateStatsError}</Text> : null}

                <Row gutter={[16, 16]}>
                  <Col xs={24} md={8}>
                    <Card size="small">
                      <Statistic title={t.risk} value={dateStats?.stats.riskCount ?? 0} />
                    </Card>
                  </Col>
                  <Col xs={24} md={8}>
                    <Card size="small">
                      <Statistic
                        title={t.negativePercent}
                        value={dateStats?.stats.negativePercent ?? 0}
                        suffix="%"
                      />
                    </Card>
                  </Col>
                  <Col xs={24} md={8}>
                    <Card size="small">
                      <Statistic
                        title={t.recognitionsInRange}
                        value={dateStats?.stats.recognitionsCount ?? 0}
                      />
                    </Card>
                  </Col>
                </Row>

                <EmotionTimelineChart points={dateStats?.points ?? []} locale={safeLocale} />

                <List
                  header={t.recentInRange}
                  dataSource={dateStats?.recent ?? []}
                  locale={{ emptyText: t.noData }}
                  renderItem={(item) => (
                    <List.Item>
                      <Space>
                        <Text strong>{formatDateTime(item.detectedAt, safeLocale)}</Text>
                        <Tag color={moodColor(item.mood)}>{item.mood}</Tag>
                      </Space>
                    </List.Item>
                  )}
                />
              </Space>
            </Card>
          </Col>
        </Row>
      )}
    </MainLayout>
  );
}
