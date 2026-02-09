"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag, Typography } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";

const { Text } = Typography;

async function waitForFaceApi(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const faceapi = (window as any).faceapi;
    if (faceapi) return faceapi;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export default function WebcamTile() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [faceFound, setFaceFound] = useState(false);
  const [faceCount, setFaceCount] = useState(0);
  const [detectStatus, setDetectStatus] = useState("detection idle");

  useEffect(() => {
    let mounted = true;

    async function startWebcam() {
      const video = videoRef.current;
      if (!video) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 25, max: 30 },
          },
          audio: false,
        });
        mediaStreamRef.current = stream;
        video.srcObject = stream;
        await video.play();
        if (mounted) setStatus("ready");
      } catch (error) {
        console.error("[webcam] stream error:", error);
        if (mounted) setStatus("error");
      }
    }

    void startWebcam();
    return () => {
      mounted = false;
      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          track.stop();
        }
        mediaStreamRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let timer = 0;

    async function startDetection() {
      const video = videoRef.current;
      const capture = captureRef.current;
      const overlay = overlayRef.current;
      if (!video || !capture || !overlay) return;

      const faceapi = await waitForFaceApi();
      if (!faceapi) {
        setDetectStatus("faceapi unavailable");
        return;
      }

      try {
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
          faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
        ]);
        setDetectStatus("detection active");
      } catch (error) {
        console.error("[webcam] failed to load face models:", error);
        setDetectStatus("model load error");
        return;
      }

      const ssdOptions = new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.45,
        maxResults: 10,
      });
      const tinyOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.28,
      });

      const loop = async () => {
        if (!mounted) return;

        try {
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            setDetectStatus("no frames");
            throw new Error("empty_frame");
          }

          capture.width = video.videoWidth;
          capture.height = video.videoHeight;
          const captureCtx = capture.getContext("2d", { willReadFrequently: true });
          if (!captureCtx) {
            setDetectStatus("no frame context");
            throw new Error("no_capture_context");
          }

          captureCtx.drawImage(video, 0, 0, capture.width, capture.height);

          let detections = await faceapi.detectAllFaces(capture, ssdOptions);
          if (!detections.length) {
            detections = await faceapi.detectAllFaces(capture, tinyOptions);
          }
          const count = detections.length;

          overlay.width = capture.width;
          overlay.height = capture.height;
          const overlayCtx = overlay.getContext("2d");
          overlayCtx?.clearRect(0, 0, overlay.width, overlay.height);

          const resized = faceapi.resizeResults(detections, {
            width: overlay.width,
            height: overlay.height,
          });
          faceapi.draw.drawDetections(overlay, resized);

          setFaceCount(count);
          setFaceFound(count > 0);
          setDetectStatus(count > 0 ? "face detected" : "searching");
        } catch (error) {
          console.error("[webcam] detection error:", error);
        }

        timer = window.setTimeout(() => {
          void loop();
        }, 200);
      };

      void loop();
    }

    if (status === "ready") {
      void startDetection();
    }

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [status]);

  return (
    <Card className="camera-card" size="small">
      <div className="camera-media">
        <video ref={videoRef} className="camera-video" muted playsInline />
        <canvas ref={captureRef} style={{ display: "none" }} />
        <canvas ref={overlayRef} className="camera-overlay" />
        {status !== "ready" ? (
          <div className="camera-status">
            <VideoCameraOutlined /> {status === "error" ? "Error" : "Loading"}
          </div>
        ) : null}
      </div>
      <div className="camera-footer">
        <div>
          <Text strong>Webcam</Text>
          <div>
            <Text type="secondary">local device</Text>
          </div>
          <div>
            <Text type="secondary">
              {faceFound ? `Face found: ${faceCount}` : `No faces: ${faceCount}`} - {detectStatus}
            </Text>
          </div>
        </div>
        <Tag color={faceFound ? "green" : "geekblue"}>{faceFound ? "Face Found" : "Webcam"}</Tag>
      </div>
    </Card>
  );
}

