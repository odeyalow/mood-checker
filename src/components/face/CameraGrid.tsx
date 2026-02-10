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
};

export default function CameraGrid({ labels }: { labels: CameraLabels }) {
  return (
    <Row gutter={[16, 16]}>
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={12} lg={12}>
          <CameraTile camera={camera} labels={labels} />
        </Col>
      ))}
    </Row>
  );
}
