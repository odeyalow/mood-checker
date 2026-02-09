"use client";

import { Row, Col } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";
import WebcamTile from "./WebcamTile";

const SHOW_WEBCAM_TILE = process.env.NEXT_PUBLIC_ENABLE_WEBCAM_TILE === "true";
type DetectionMode = "browser" | "worker";

export default function CameraGrid({ detectionMode }: { detectionMode: DetectionMode }) {
  return (
    <Row gutter={[16, 16]}>
      {SHOW_WEBCAM_TILE && detectionMode === "browser" ? (
        <Col key="webcam-local" xs={24} md={12} lg={12}>
          <WebcamTile />
        </Col>
      ) : null}
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={12} lg={12}>
          <CameraTile camera={camera} detectionMode={detectionMode} />
        </Col>
      ))}
    </Row>
  );
}
