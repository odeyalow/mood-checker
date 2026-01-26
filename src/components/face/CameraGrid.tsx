"use client";

import { Col, Row, Segmented, Space, Typography } from "antd";
import { useState } from "react";
import CameraTile from "./CameraTile";

const { Text } = Typography;

const CAMERAS = [
  {
    id: "cam-01",
    name: "Аудитория 203",
    location: "Корпус A",
    rtspUrl: "rtsp://user:pass@192.168.0.10:554/stream",
    type: "rtsp",
  },
  {
    id: "cam-02",
    name: "Лаборатория 5",
    location: "Корпус B",
    rtspUrl: "rtsp://user:pass@192.168.0.11:554/stream",
    type: "rtsp",
  },
  {
    id: "cam-03",
    name: "Библиотека",
    location: "1 этаж",
    type: "webcam",
  },
];

export default function CameraGrid() {
  const [view, setView] = useState("Grid");

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
        <Text type="secondary">
          Камеры добавляются через код: массив `CAMERAS` в компоненте.
        </Text>
        <Segmented
          options={["Grid", "Focus"]}
          value={view}
          onChange={(value) => setView(String(value))}
        />
      </Space>
      <Row gutter={[16, 16]}>
        {CAMERAS.map((camera) => (
          <Col
            key={camera.id}
            xs={24}
            md={view === "Focus" ? 24 : 12}
            xl={view === "Focus" ? 24 : 8}
          >
            <CameraTile camera={camera} />
          </Col>
        ))}
      </Row>
    </Space>
  );
}