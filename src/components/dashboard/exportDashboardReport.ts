import { classifyMood } from "@/lib/mood";

export type ReportLocale = "ru" | "kz" | "en";

type ReportStats = {
  connectedCameras: number;
  recognitionsLast24h: number;
  negativePercent: number;
  riskZoneCount: number;
} | null;

type ReportEmotionPoint = {
  bucketStart: string;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

type ReportRecognition = {
  name: string;
  mood: string;
  detectedAt: string;
};

type ReportData = {
  stats: ReportStats;
  emotionPoints: ReportEmotionPoint[];
  recentEvents: ReportRecognition[];
  locale: ReportLocale;
};

const REPORT_L10N = {
  ru: {
    brand: "Mood Checker",
    reportTitle: "Экспорт данных",
    generatedAt: "Сформировано",
    disclaimer:
      "Внимание: данные могут быть неточными и носят ориентировочный характер. Используйте их как вспомогательную информацию, а не как точную статистику.",
    activeCameras: "Активные камеры",
    recognitions: "Распознаваний",
    allTime: "за всё время",
    negative: "Негатив",
    allTimeShare: "доля за всё время",
    riskZone: "Зона риска",
    emotionDynamics: "Динамика эмоций",
    moodShare: "Доля эмоций за всё время",
    positive: "Позитив",
    neutral: "Нейтрально",
    negativeLegend: "Негатив",
    recentRecognitions: "Последние распознавания",
    noRecognitions: "Пока нет распознаваний",
    colName: "Студент",
    colTime: "Время",
    colMood: "Эмоция",
    print: "Печать / Сохранить в PDF",
  },
  kz: {
    brand: "Mood Checker",
    reportTitle: "Деректерді экспорттау",
    generatedAt: "Жасалған",
    disclaimer:
      "Назар аударыңыз: деректер дәл болмауы мүмкін және бағдарлық сипатта. Оларды нақты статистика ретінде емес, қосымша ақпарат ретінде пайдаланыңыз.",
    activeCameras: "Белсенді камералар",
    recognitions: "Тану саны",
    allTime: "барлық уақыт ішінде",
    negative: "Негатив",
    allTimeShare: "барлық уақыттағы үлес",
    riskZone: "Тәуекел аймағы",
    emotionDynamics: "Эмоция динамикасы",
    moodShare: "Барлық уақыттағы эмоция үлесі",
    positive: "Позитив",
    neutral: "Нейтрал",
    negativeLegend: "Негатив",
    recentRecognitions: "Соңғы танулар",
    noRecognitions: "Әзірге танулар жоқ",
    colName: "Студент",
    colTime: "Уақыт",
    colMood: "Эмоция",
    print: "Басып шығару / PDF сақтау",
  },
  en: {
    brand: "Mood Checker",
    reportTitle: "Data export",
    generatedAt: "Generated",
    disclaimer:
      "Note: the data may be inaccurate and is indicative only. Use it as supporting information, not as exact statistics.",
    activeCameras: "Active cameras",
    recognitions: "Recognitions",
    allTime: "all time",
    negative: "Negative",
    allTimeShare: "all-time share",
    riskZone: "Risk zone",
    emotionDynamics: "Emotion dynamics",
    moodShare: "Emotion share (all time)",
    positive: "Positive",
    neutral: "Neutral",
    negativeLegend: "Negative",
    recentRecognitions: "Recent recognitions",
    noRecognitions: "No recognitions yet",
    colName: "Student",
    colTime: "Time",
    colMood: "Mood",
    print: "Print / Save as PDF",
  },
} as const;

const COLORS = {
  positive: "#22c55e",
  neutral: "#3b82f6",
  negative: "#ef4444",
  negativeStat: "#dc2626",
  brand: "#4f46e5",
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  cardBg: "#f8fafc",
  warnBg: "#fef3c7",
  warnBorder: "#f59e0b",
  warnText: "#92400e",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function localeTag(locale: ReportLocale): string {
  return locale === "kz" ? "kk-KZ" : locale === "en" ? "en-US" : "ru-RU";
}

function formatTime(value: string, locale: ReportLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleTimeString(localeTag(locale), { hour: "2-digit", minute: "2-digit" });
}

function buildPolyline(values: number[], maxValue: number, width: number, height: number): string {
  if (!values.length) return "";
  const safeMax = maxValue <= 0 ? 1 : maxValue;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = Math.round(index * stepX * 100) / 100;
      const y = Math.round((height - (value / safeMax) * height) * 100) / 100;
      return `${x},${y}`;
    })
    .join(" ");
}

function moodAccent(mood: string): string {
  const kind = classifyMood(mood);
  if (kind === "negative") return COLORS.negative;
  if (kind === "positive") return COLORS.positive;
  return COLORS.neutral;
}

function buildChartSvg(points: ReportEmotionPoint[], locale: ReportLocale): string {
  const width = 800;
  const height = 220;
  if (!points.length) {
    return `<div class="empty">—</div>`;
  }
  const positive = points.map((p) => Number(p.positiveCount) || 0);
  const neutral = points.map((p) => Number(p.neutralCount) || 0);
  const negative = points.map((p) => Number(p.negativeCount) || 0);
  const maxValue = Math.max(1, ...positive, ...neutral, ...negative);

  const startLabel = formatTime(points[0].bucketStart, locale);
  const endLabel = formatTime(points[points.length - 1].bucketStart, locale);

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img">
      <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="${COLORS.border}" stroke-width="1" />
      <polyline fill="none" stroke="${COLORS.positive}" stroke-width="3" points="${buildPolyline(positive, maxValue, width, height)}" />
      <polyline fill="none" stroke="${COLORS.neutral}" stroke-width="3" points="${buildPolyline(neutral, maxValue, width, height)}" />
      <polyline fill="none" stroke="${COLORS.negative}" stroke-width="3" points="${buildPolyline(negative, maxValue, width, height)}" />
    </svg>
    <div class="axis"><span>${escapeHtml(startLabel)}</span><span>${escapeHtml(endLabel)}</span></div>
    <div class="legend">
      <span><i style="background:${COLORS.positive}"></i>${escapeHtml(REPORT_L10N[locale].positive)}</span>
      <span><i style="background:${COLORS.neutral}"></i>${escapeHtml(REPORT_L10N[locale].neutral)}</span>
      <span><i style="background:${COLORS.negative}"></i>${escapeHtml(REPORT_L10N[locale].negativeLegend)}</span>
    </div>`;
}

function buildReportDocument(data: ReportData, forPrint: boolean): string {
  const { stats, emotionPoints, recentEvents, locale } = data;
  const t = REPORT_L10N[locale] ?? REPORT_L10N.ru;
  const generatedAt = new Date().toLocaleString(localeTag(locale));

  const totalPositive = emotionPoints.reduce((s, p) => s + (Number(p.positiveCount) || 0), 0);
  const totalNeutral = emotionPoints.reduce((s, p) => s + (Number(p.neutralCount) || 0), 0);
  const totalNegative = emotionPoints.reduce((s, p) => s + (Number(p.negativeCount) || 0), 0);
  const totalMoods = totalPositive + totalNeutral + totalNegative;
  const pct = (value: number) => (totalMoods > 0 ? Math.round((value / totalMoods) * 100) : 0);

  const statCard = (label: string, value: string | number, sub: string, accent?: string) => `
    <div class="stat">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value" ${accent ? `style="color:${accent}"` : ""}>${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
    </div>`;

  const recentRows = recentEvents.length
    ? recentEvents
        .map(
          (item) => `
        <tr>
          <td>${escapeHtml(item.name || "Unknown")}</td>
          <td>${formatTime(item.detectedAt, locale)}</td>
          <td><span class="mood" style="background:${moodAccent(item.mood)}22;color:${moodAccent(item.mood)}">${escapeHtml(item.mood)}</span></td>
        </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">${escapeHtml(t.noRecognitions)}</td></tr>`;

  const moodBar = totalMoods
    ? `
      <div class="moodbar">
        <div style="width:${pct(totalPositive)}%;background:${COLORS.positive}"></div>
        <div style="width:${pct(totalNeutral)}%;background:${COLORS.neutral}"></div>
        <div style="width:${pct(totalNegative)}%;background:${COLORS.negative}"></div>
      </div>
      <div class="legend">
        <span><i style="background:${COLORS.positive}"></i>${escapeHtml(t.positive)} ${pct(totalPositive)}%</span>
        <span><i style="background:${COLORS.neutral}"></i>${escapeHtml(t.neutral)} ${pct(totalNeutral)}%</span>
        <span><i style="background:${COLORS.negative}"></i>${escapeHtml(t.negativeLegend)} ${pct(totalNegative)}%</span>
      </div>`
    : `<div class="empty">—</div>`;

  const printExtras = forPrint
    ? `<button class="print-btn" onclick="window.print()">${escapeHtml(t.print)}</button>
       <script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);});</script>`
    : "";

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(t.brand)} — ${escapeHtml(t.reportTitle)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: ${COLORS.text}; margin: 0; padding: 24px; background: #ffffff; width: 794px; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid ${COLORS.brand}; padding-bottom: 12px; }
  .brand { font-size: 22px; font-weight: 700; color: ${COLORS.brand}; }
  .subtitle { font-size: 13px; color: ${COLORS.muted}; }
  .generated { font-size: 12px; color: ${COLORS.muted}; text-align: right; }
  .disclaimer { margin: 16px 0; padding: 14px 16px; background: ${COLORS.warnBg}; border: 2px solid ${COLORS.warnBorder};
    border-radius: 10px; color: ${COLORS.warnText}; font-size: 14px; font-weight: 600; display: flex; gap: 10px; align-items: flex-start; }
  .disclaimer .icon { font-size: 18px; line-height: 1.2; }
  .section-title { font-size: 15px; font-weight: 700; margin: 22px 0 10px; }
  .stats { display: flex; gap: 12px; }
  .stat { flex: 1; background: ${COLORS.cardBg}; border: 1px solid ${COLORS.border}; border-radius: 10px; padding: 14px; }
  .stat-label { font-size: 12px; color: ${COLORS.muted}; }
  .stat-value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .stat-sub { font-size: 11px; color: ${COLORS.muted}; margin-top: 2px; }
  .card { background: #fff; border: 1px solid ${COLORS.border}; border-radius: 10px; padding: 16px; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; color: ${COLORS.muted}; margin-top: 6px; }
  .moodbar { display: flex; height: 18px; border-radius: 9px; overflow: hidden; border: 1px solid ${COLORS.border}; }
  .moodbar div { height: 100%; }
  .legend { display: flex; gap: 18px; margin-top: 10px; font-size: 12px; color: ${COLORS.text}; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid ${COLORS.border}; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: ${COLORS.muted}; }
  .mood { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .muted { color: ${COLORS.muted}; }
  .empty { color: ${COLORS.muted}; padding: 16px 0; text-align: center; }
  .print-btn { position: fixed; top: 16px; right: 16px; background: ${COLORS.brand}; color: #fff; border: none;
    padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  ${printExtras}
  <div class="header">
    <div>
      <div class="brand">${escapeHtml(t.brand)}</div>
      <div class="subtitle">${escapeHtml(t.reportTitle)}</div>
    </div>
    <div class="generated">${escapeHtml(t.generatedAt)}:<br/>${escapeHtml(generatedAt)}</div>
  </div>

  <div class="disclaimer">
    <span class="icon">⚠</span>
    <span>${escapeHtml(t.disclaimer)}</span>
  </div>

  <div class="stats">
    ${statCard(t.activeCameras, stats?.connectedCameras ?? 0, "")}
    ${statCard(t.recognitions, stats?.recognitionsLast24h ?? 0, t.allTime)}
    ${statCard(t.negative, `${stats?.negativePercent ?? 0}%`, t.allTimeShare, COLORS.negativeStat)}
    ${statCard(t.riskZone, stats?.riskZoneCount ?? 0, t.allTime)}
  </div>

  <div class="section-title">${escapeHtml(t.emotionDynamics)}</div>
  <div class="card">${buildChartSvg(emotionPoints, locale)}</div>

  <div class="section-title">${escapeHtml(t.moodShare)}</div>
  <div class="card">${moodBar}</div>

  <div class="section-title">${escapeHtml(t.recentRecognitions)}</div>
  <div class="card">
    <table>
      <thead><tr><th>${escapeHtml(t.colName)}</th><th>${escapeHtml(t.colTime)}</th><th>${escapeHtml(t.colMood)}</th></tr></thead>
      <tbody>${recentRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function printFallback(html: string, locale: ReportLocale): void {
  const win = window.open("", "_blank");
  if (!win) {
    window.alert(
      locale === "kz"
        ? "Терезе бұғатталды. PDF экспорты үшін қалқымалы терезелерге рұқсат беріңіз."
        : locale === "en"
          ? "Popup blocked. Please allow popups to export the PDF."
          : "Всплывающее окно заблокировано. Разрешите всплывающие окна для экспорта PDF.",
    );
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

// Builds the report and downloads it as a PDF file. Renders into an isolated
// off-screen iframe (so the app's CSS can't interfere with html2canvas), captures
// it, and saves a PDF. Falls back to a printable window if capture fails.
export async function exportDashboardReport(data: ReportData): Promise<void> {
  const { locale } = data;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = "794px";
  iframe.style.height = "10px";
  iframe.style.border = "0";
  iframe.style.background = "#ffffff";
  document.body.appendChild(iframe);

  try {
    const idoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!idoc) throw new Error("iframe document unavailable");
    idoc.open();
    idoc.write(buildReportDocument(data, false));
    idoc.close();

    await new Promise((resolve) => setTimeout(resolve, 350));
    const body = idoc.body;
    const contentHeight = Math.max(body.scrollHeight, body.offsetHeight, 600);
    iframe.style.height = `${contentHeight}px`;

    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(body, {
      scale: 2,
      backgroundColor: "#ffffff",
      width: 794,
      windowWidth: 794,
      height: contentHeight,
      windowHeight: contentHeight,
    });

    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;
    const imgData = canvas.toDataURL("image/png");

    let heightLeft = imgH;
    let position = 0;
    pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
      heightLeft -= pageH;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`mood-checker-${stamp}.pdf`);
  } catch {
    // Capture failed for any reason — fall back to the always-works print path.
    printFallback(buildReportDocument(data, true), locale);
  } finally {
    iframe.remove();
  }
}
