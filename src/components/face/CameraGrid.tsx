"use client";

import { Row, Col } from "antd";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";
import WebcamTile from "./WebcamTile";

const SHOW_WEBCAM_TILE = process.env.NEXT_PUBLIC_ENABLE_WEBCAM_TILE === "true";

export default function CameraGrid() {
  return (
    <Row gutter={[16, 16]}>
      {SHOW_WEBCAM_TILE ? (
        <Col key="webcam-local" xs={24} md={12} lg={12}>
          <WebcamTile />
        </Col>
      ) : null}
      {CAMERA_CONFIGS.map((camera) => (
        <Col key={camera.id} xs={24} md={12} lg={12}>
          <CameraTile camera={camera} />
        </Col>
      ))}
    </Row>
  );
}
