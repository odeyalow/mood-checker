"use client";

type EmotionPoint = {
  bucketStart: string;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

function buildPolyline(
  values: number[],
  maxValue: number,
  width: number,
  height: number
) {
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

export default function EmotionTimelineChart({ points }: { points: EmotionPoint[] }) {
  const width = 860;
  const height = 220;
  const positive = points.map((p) => p.positiveCount);
  const neutral = points.map((p) => p.neutralCount);
  const negative = points.map((p) => p.negativeCount);
  const maxValue = Math.max(1, ...positive, ...neutral, ...negative);

  const startLabel = points[0]
    ? new Date(points[0].bucketStart).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "--:--";
  const endLabel = points[points.length - 1]
    ? new Date(points[points.length - 1].bucketStart).toLocaleTimeString("ru-RU", {
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
        <span style={{ color: "#22c55e" }}>Позитив</span>
        <span style={{ color: "#3b82f6" }}>Нейтрально</span>
        <span style={{ color: "#ef4444" }}>Негатив</span>
      </div>
    </div>
  );
}
