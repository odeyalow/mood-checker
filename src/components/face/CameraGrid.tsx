"use client";

import { Col, Row } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";

export default function CameraGrid({ locale = "ru" }: { locale?: "ru" | "kz" | "en" }) {
  return (
    <Row gutter={[16, 16]}>
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={12}>
          <CameraTile key={`grid-${camera.id}`} camera={camera} mode="full" locale={locale} />
        </Col>
      ))}
    </Row>
  );
}
