export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl: string;
  go2rtcSrc?: string;
  digitalZoom?: number;
};

function parseDigitalZoom(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 1) return undefined;
  return Math.min(parsed, 4);
}

const camera1Rtsp =
  process.env.NEXT_PUBLIC_CAMERA_1_RTSP_URL ||
  "rtsp://danil:danil_2004@192.168.0.36:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif";
const camera1Go2rtcSrc = process.env.NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC || "cam01_main";

const camera1Name = process.env.NEXT_PUBLIC_CAMERA_1_NAME || "Camera 1";
const camera1Location = process.env.NEXT_PUBLIC_CAMERA_1_LOCATION || "192.168.0.36";
const camera1DigitalZoom = parseDigitalZoom(process.env.NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM);

const camera2Rtsp =
  process.env.NEXT_PUBLIC_CAMERA_2_RTSP_URL ||
  "rtsp://danil:danil_2004@192.168.0.241:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif";
const camera2Go2rtcSrc = process.env.NEXT_PUBLIC_CAMERA_2_GO2RTC_SRC || "cam02_main";

const camera2Name = process.env.NEXT_PUBLIC_CAMERA_2_NAME || "Camera 2";
const camera2Location = process.env.NEXT_PUBLIC_CAMERA_2_LOCATION || "192.168.0.241";
const camera2DigitalZoom = parseDigitalZoom(process.env.NEXT_PUBLIC_CAMERA_2_DIGITAL_ZOOM);

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: camera1Name,
    location: camera1Location,
    rtspUrl: camera1Rtsp,
    go2rtcSrc: camera1Go2rtcSrc,
    digitalZoom: camera1DigitalZoom,
  },
  {
    id: "cam-02",
    name: camera2Name,
    location: camera2Location,
    rtspUrl: camera2Rtsp,
    go2rtcSrc: camera2Go2rtcSrc,
    digitalZoom: camera2DigitalZoom,
  },
];
