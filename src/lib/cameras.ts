export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl: string;
};

const camera1Rtsp =
  process.env.NEXT_PUBLIC_CAMERA_1_RTSP_URL ||
  "rtsp://danil:danil_2004@192.168.0.36:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif";

const camera1Name = process.env.NEXT_PUBLIC_CAMERA_1_NAME || "Camera 1";
const camera1Location = process.env.NEXT_PUBLIC_CAMERA_1_LOCATION || "192.168.0.36";

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: camera1Name,
    location: camera1Location,
    rtspUrl: camera1Rtsp,
  },
];
