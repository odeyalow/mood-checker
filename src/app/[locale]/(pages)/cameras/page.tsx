"use client";

import { use, useMemo } from "react";
import { Card, Segmented, Space, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import MainLayout from "@/components/layouts/MainLayout";
import CameraGrid from "@/components/face/CameraGrid";
import FaceScripts from "@/components/face/FaceScripts";

const { Text } = Typography;
type DetectionMode = "browser" | "worker";

export default function CamerasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const mode: DetectionMode = useMemo(() => {
    const raw = searchParams.get("mode");
    if (raw === "worker" || raw === "browser") return raw;
    return process.env.NEXT_PUBLIC_DETECTION_MODE === "worker" ? "worker" : "browser";
  }, [searchParams]);

  const setMode = (nextMode: DetectionMode) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("mode", nextMode);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <MainLayout title="Cameras" locale={locale}>
      <FaceScripts includeFaceApi={mode === "browser"} />
      <Card className="soft-card">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Segmented
            value={mode}
            options={[
              { label: "Browser Detection", value: "browser" },
              { label: "Worker Detection", value: "worker" },
            ]}
            onChange={(value) => setMode(value as DetectionMode)}
          />
          <Text type="secondary">
            {mode === "browser"
              ? "Detection runs in browser (face-api)."
              : "Detection runs in Python worker; UI shows worker status."}
          </Text>
          <CameraGrid detectionMode={mode} />
        </Space>
      </Card>
    </MainLayout>
  );
}

