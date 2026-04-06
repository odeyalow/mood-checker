export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl: string;
  go2rtcSrc?: string;
  digitalZoom?: number;
  previewMode?: "stream" | "snapshot" | "mjpeg";
};

function parseDigitalZoom(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 1) return undefined;
  return Math.min(parsed, 4);
}

function parsePreviewMode(
  rawValue: string | undefined,
): "stream" | "snapshot" | "mjpeg" | undefined {
  if (!rawValue) return undefined;
  if (rawValue === "snapshot") return "snapshot";
  if (rawValue === "mjpeg") return "mjpeg";
  if (rawValue === "stream") return "stream";
  return undefined;
}

const camera1Rtsp =
  process.env.NEXT_PUBLIC_CAMERA_1_RTSP_URL || "rtsp://user:user123@10.16.12.39:554/stream";
const camera1Go2rtcSrc = process.env.NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC || "cam01_main";

const camera1Name = process.env.NEXT_PUBLIC_CAMERA_1_NAME || "Camera 1";
const camera1Location = process.env.NEXT_PUBLIC_CAMERA_1_LOCATION || "10.16.12.39";
const camera1DigitalZoom = parseDigitalZoom(process.env.NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM);
const camera1PreviewMode = parsePreviewMode(process.env.NEXT_PUBLIC_CAMERA_1_PREVIEW_MODE);

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: camera1Name,
    location: camera1Location,
    rtspUrl: camera1Rtsp,
    go2rtcSrc: camera1Go2rtcSrc,
    digitalZoom: camera1DigitalZoom,
    previewMode: camera1PreviewMode,
  },
];
