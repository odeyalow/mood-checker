export type CameraConfig = {
  id: string;
  name: string;
  location?: string;
  rtspUrl: string;
};

export const CAMERA_CONFIGS: CameraConfig[] = [
  {
    id: "cam-01",
    name: "RTSP камера 192.168.0.36",
    location: "192.168.0.36",
    rtspUrl:
      "rtsp://danil:danil_2004@192.168.0.36:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif",
  },
];
