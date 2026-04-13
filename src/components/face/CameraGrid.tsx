"use client";

import { Row, Col } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";

type CameraLabels = {
  loading: string;
  error: string;
  recognized: string;
  noRecognitions: string;
  emotion: string;
  snapshotTitle: string;
  whoLabel: string;
  emotionLabel: string;
  unknownLabel: string;
  noneLabel: string;
  downloadFrame: string;
  downloadingFrame: string;
};

export default function CameraGrid({ labels }: { labels: CameraLabels }) {
  const singleCamera = CAMERA_CONFIGS.length === 1;

  return (
    <Row gutter={[16, 16]}>
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={singleCamera ? 24 : 12} lg={singleCamera ? 24 : 12}>
          <CameraTile camera={camera} labels={labels} />
        </Col>
      ))}
    </Row>
  );
}
