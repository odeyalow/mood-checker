"use client";

import { use } from "react";
import { Card, Space } from "antd";
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
    <MainLayout title="Cameras" locale={locale}>
      <FaceScripts includeFaceApi={false} />
      <Card className="soft-card">
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <CameraGrid />
        </Space>
      </Card>
    </MainLayout>
  );
}
