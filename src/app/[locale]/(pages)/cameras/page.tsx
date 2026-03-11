"use client";

import Link from "next/link";
import { use } from "react";
import { Button, Card, Space } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

const TEXT = {
  ru: {
    title: "\u041a\u0430\u043c\u0435\u0440\u044b",
    loading: "\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430",
    error: "\u041e\u0448\u0438\u0431\u043a\u0430",
    recognized: "\u0420\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u043d",
    noRecognitions: "\u0420\u0430\u0441\u043f\u043e\u0437\u043d\u0430\u043d\u0438\u0439 \u043d\u0435\u0442",
    emotionPlaceholder: "-",
    snapshotTitle: "\u0421\u043d\u0438\u043c\u043e\u043a",
    whoLabel: "\u041a\u0442\u043e",
    emotionLabel: "\u042d\u043c\u043e\u0446\u0438\u044f",
    unknownLabel: "\u043d\u0435 \u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d",
    noneLabel: "\u043d\u0435\u0442",
    downloadFrame: "\u0421\u043a\u0430\u0447\u0430\u0442\u044c \u043a\u0430\u0434\u0440",
    downloadingFrame: "\u0421\u043a\u0430\u0447\u0438\u0432\u0430\u0435\u043c...",
    dedupJournal: "\u0416\u0443\u0440\u043d\u0430\u043b \u043c\u0430\u0442\u0447\u0438\u043d\u0433\u0430",
  },
  kz: {
    title: "\u041a\u0430\u043c\u0435\u0440\u0430\u043b\u0430\u0440",
    loading: "\u0416\u04af\u043a\u0442\u0435\u043b\u0443\u0434\u0435",
    error: "\u049a\u0430\u0442\u0435",
    recognized: "\u0422\u0430\u043d\u044b\u043b\u0434\u044b",
    noRecognitions: "\u0422\u0430\u043d\u044b\u043b\u0443 \u0436\u043e\u049b",
    emotionPlaceholder: "-",
    snapshotTitle: "\u0421\u0443\u0440\u0435\u0442",
    whoLabel: "\u041a\u0456\u043c",
    emotionLabel: "\u042d\u043c\u043e\u0446\u0438\u044f",
    unknownLabel: "\u0430\u043d\u044b\u049b\u0442\u0430\u043b\u043c\u0430\u0434\u044b",
    noneLabel: "\u0436\u043e\u049b",
    downloadFrame: "\u041a\u0430\u0434\u0440\u0434\u044b \u0436\u04af\u043a\u0442\u0435\u0443",
    downloadingFrame: "\u0416\u04af\u043a\u0442\u0435\u043b\u0443\u0434\u0435...",
    dedupJournal: "\u041c\u0430\u0442\u0447\u0438\u043d\u0433 \u0436\u0443\u0440\u043d\u0430\u043b\u044b",
  },
  en: {
    title: "Cameras",
    loading: "Loading",
    error: "Error",
    recognized: "Recognized",
    noRecognitions: "No recognitions",
    emotionPlaceholder: "-",
    snapshotTitle: "Snapshot",
    whoLabel: "Who",
    emotionLabel: "Emotion",
    unknownLabel: "unknown",
    noneLabel: "none",
    downloadFrame: "Download frame",
    downloadingFrame: "Downloading...",
    dedupJournal: "Matching Journal",
  },
};

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale = locale === "ru" || locale === "kz" || locale === "en" ? locale : "ru";
  const t = TEXT[safeLocale];

  return (
    <MainLayout title={t.title} locale={safeLocale}>
      <FaceScripts includeFaceApi={false} />
      <Card className="soft-card">
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Link href={`/${safeLocale}/matching-journal`}>
            <Button size="small">{t.dedupJournal}</Button>
          </Link>
          <CameraGrid
            labels={{
              loading: t.loading,
              error: t.error,
              recognized: t.recognized,
              noRecognitions: t.noRecognitions,
              emotion: t.emotionPlaceholder,
              snapshotTitle: t.snapshotTitle,
              whoLabel: t.whoLabel,
              emotionLabel: t.emotionLabel,
              unknownLabel: t.unknownLabel,
              noneLabel: t.noneLabel,
              downloadFrame: t.downloadFrame,
              downloadingFrame: t.downloadingFrame,
            }}
          />
        </Space>
      </Card>
    </MainLayout>
  );
}
