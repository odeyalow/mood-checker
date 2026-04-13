export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  go2rtcSrc?: string;
  digitalZoom?: number;
  frameOffsetY?: number;
};

function parseDigitalZoom(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 1) return undefined;
  return Math.min(parsed, 4);
}

function parseFrameOffsetY(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(0.35, Math.max(-0.35, parsed));
}

const camera1Go2rtcSrc = process.env.NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC || "cam01_main";

const camera1Name = process.env.NEXT_PUBLIC_CAMERA_1_NAME || "Camera 1";
const camera1Location = process.env.NEXT_PUBLIC_CAMERA_1_LOCATION || "10.16.12.39";
const camera1DigitalZoom = parseDigitalZoom(process.env.NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM) ?? 1;
const camera1FrameOffsetY =
  parseFrameOffsetY(process.env.NEXT_PUBLIC_CAMERA_1_FRAME_OFFSET_Y) ?? 0;

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: camera1Name,
    location: camera1Location,
    go2rtcSrc: camera1Go2rtcSrc,
    digitalZoom: camera1DigitalZoom,
    frameOffsetY: camera1FrameOffsetY,
  },
];
