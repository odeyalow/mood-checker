export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl?: string;
  type?: "rtsp" | "webcam";
};

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: "Основная RTSP камера",
    location: "192.168.0.36",
    rtspUrl:
      "rtsp://danil:danil_2004@192.168.0.36:554/cam/realmonitor?channel=1&subtype=1&unicast=true&proto=Onvif",
    type: "rtsp",
  },
];
