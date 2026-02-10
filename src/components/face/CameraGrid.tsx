"use client";

import { Row, Col } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";

export default function CameraGrid() {
  return (
    <Row gutter={[16, 16]}>
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={12} lg={12}>
          <CameraTile camera={camera} />
        </Col>
      ))}
    </Row>
  );
}
