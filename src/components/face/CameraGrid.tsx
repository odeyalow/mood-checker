"use client";

import { Col, Row, Space, Typography } from "antd";
import { useMemo, useState } from "react";
import { CAMERA_CONFIGS } from "@/lib/cameras";
import CameraTile from "./CameraTile";

const { Text } = Typography;

export default function CameraGrid() {
  const [focusedCameraId, setFocusedCameraId] = useState(
    CAMERA_CONFIGS[0]?.id ?? ""
  );

  const focusedCamera = useMemo(
    () => CAMERA_CONFIGS.find((camera) => camera.id === focusedCameraId) ?? CAMERA_CONFIGS[0],
    [focusedCameraId]
  );

  const secondaryCameras = useMemo(
    () => CAMERA_CONFIGS.filter((camera) => camera.id !== focusedCamera?.id),
    [focusedCamera]
  );

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Space
        align="center"
        style={{ width: "100%", justifyContent: "space-between" }}
      >
        <Text type="secondary">
          Камеры добавляются через код: массив `CAMERA_CONFIGS` в `src/lib/cameras.ts`.
        </Text>
      </Space>

      {focusedCamera ? (
        <div>
          <CameraTile camera={focusedCamera} />
        </div>
      ) : null}

      {secondaryCameras.length > 0 ? (
        <Row gutter={[16, 16]}>
          {secondaryCameras.map((camera) => (
            <Col key={camera.id} xs={24} md={12} xl={8}>
              <button
                type="button"
                onClick={() => setFocusedCameraId(camera.id)}
                style={{
                  width: "100%",
                  border: "none",
                  padding: 0,
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                aria-label={`Показать ${camera.name} на главной области`}
              >
                <CameraTile camera={camera} />
              </button>
            </Col>
          ))}
        </Row>
      ) : null}

      {CAMERA_CONFIGS.length > 1 ? (
        <Text type="secondary">
          Нажмите на камеру внизу, чтобы вывести ее в большую область.
        </Text>
      ) : null}
    </Space>
  );
}
