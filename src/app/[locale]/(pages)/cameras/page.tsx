"use client";

import { use } from "react";
import { Card } from "antd";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);

  return (
    <MainLayout title="Камеры" locale={locale}>
      <FaceScripts />
      <Card className="soft-card">
        <CameraGrid />
      </Card>
    </MainLayout>
  );
}
