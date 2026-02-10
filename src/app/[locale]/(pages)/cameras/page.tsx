"use client";

import { use } from "react";
import { Card, Space } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

const TEXT = {
  ru: {
    title: "Камеры",
    loading: "Загрузка",
    error: "Ошибка",
    recognized: "Распознан",
    noRecognitions: "Распознаний нет",
    emotionPlaceholder: "-",
  },
  kk: {
    title: "Камералар",
    loading: "Жүктелуде",
    error: "Қате",
    recognized: "Танылды",
    noRecognitions: "Танулар жоқ",
    emotionPlaceholder: "-",
  },
  en: {
    title: "Cameras",
    loading: "Loading",
    error: "Error",
    recognized: "Recognized",
    noRecognitions: "No recognitions",
    emotionPlaceholder: "-",
  },
};

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const safeLocale = locale === "ru" || locale === "kk" || locale === "en" ? locale : "ru";
  const t = TEXT[safeLocale];

  return (
    <MainLayout title={t.title} locale={locale}>
      <FaceScripts includeFaceApi={false} />
      <Card className="soft-card">
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <CameraGrid
            labels={{
              loading: t.loading,
              error: t.error,
              recognized: t.recognized,
              noRecognitions: t.noRecognitions,
              emotion: t.emotionPlaceholder,
            }}
          />
        </Space>
      </Card>
    </MainLayout>
  );
}
