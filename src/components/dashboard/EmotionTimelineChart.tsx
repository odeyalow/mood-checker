"use client";

type EmotionPoint = {
  bucketStart: string;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

type AppLocale = "ru" | "kz" | "en";

const CHART_L10N = {
  ru: { positive: "Позитив", neutral: "Нейтрально", negative: "Негатив" },
  kz: { positive: "Позитив", neutral: "Нейтрал", negative: "Негатив" },
  en: { positive: "Positive", neutral: "Neutral", negative: "Negative" },
} as const;

function buildPolyline(values: number[], maxValue: number, width: number, height: number) {
  if (values.length === 0) return "";
  if (maxValue <= 0) maxValue = 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;

  return values
    .map((value, index) => {
      const x = Math.round(index * stepX * 100) / 100;
      const y = Math.round((height - (value / maxValue) * height) * 100) / 100;
      return `${x},${y}`;
    })
    .join(" ");
}

export default function EmotionTimelineChart({
  points,
  locale = "ru",
}: {
  points: EmotionPoint[];
  locale?: AppLocale;
}) {
  const width = 860;
  const height = 220;
  const positive = points.map((p) => p.positiveCount);
  const neutral = points.map((p) => p.neutralCount);
  const negative = points.map((p) => p.negativeCount);
  const maxValue = Math.max(1, ...positive, ...neutral, ...negative);

  const t = CHART_L10N[locale];
  const dateLocale = locale === "kz" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU";

  const startLabel = points[0]
    ? new Date(points[0].bucketStart).toLocaleTimeString(dateLocale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "--:--";
  const endLabel = points[points.length - 1]
    ? new Date(points[points.length - 1].bucketStart).toLocaleTimeString(dateLocale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "--:--";

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img">
        <line x1="0" y1={height} x2={width} y2={height} stroke="#e5e7eb" strokeWidth="1" />
        <polyline
          fill="none"
          stroke="#22c55e"
          strokeWidth="2"
          points={buildPolyline(positive, maxValue, width, height)}
        />
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
          points={buildPolyline(neutral, maxValue, width, height)}
        />
        <polyline
          fill="none"
          stroke="#ef4444"
          strokeWidth="2"
          points={buildPolyline(negative, maxValue, width, height)}
        />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <span style={{ color: "#6b7280" }}>{startLabel}</span>
        <span style={{ color: "#6b7280" }}>{endLabel}</span>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        <span style={{ color: "#22c55e" }}>{t.positive}</span>
        <span style={{ color: "#3b82f6" }}>{t.neutral}</span>
        <span style={{ color: "#ef4444" }}>{t.negative}</span>
      </div>
    </div>
  );
}
