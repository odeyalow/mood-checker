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
      "rtsp://danil:danil_2004@192.168.0.36:554/cam/realmonitor?channel=1&subtype=2&unicast=true&proto=Onvif",
    type: "rtsp",
  },
  {
    id: "cam-02",
    name: "RTSP камера 118",
    location: "192.168.0.118",
    rtspUrl:
      "rtsp://danil:danil_2004@192.168.0.118:554/cam/realmonitor?channel=1&subtype=2&unicast=true&proto=Onvif",
    type: "rtsp",
  },
  {
    id: "cam-03",
    name: "RTSP камера 226",
    location: "192.168.0.226",
    rtspUrl:
      "rtsp://danil:danil_2004@192.168.0.226:554/cam/realmonitor?channel=1&subtype=2&unicast=true&proto=Onvif",
    type: "rtsp",
  },
  {
    id: "cam-04",
    name: "RTSP камера 241",
    location: "192.168.0.241",
    rtspUrl:
      "rtsp://danil:danil_2004@192.168.0.241:554/cam/realmonitor?channel=1&subtype=2&unicast=true&proto=Onvif",
    type: "rtsp",
  },
];
