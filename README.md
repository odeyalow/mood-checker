## Mood Checker

Next.js app with camera stream preview and face recognition events.

## Run app

```bash
npm install
npm run build
npm run start
```

### Camera source via go2rtc (recommended)

Set these in `.env` for camera page:

```bash
NEXT_PUBLIC_CAMERA_1_RTSP_URL=rtsp://127.0.0.1:8554/cam01_main
NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC=cam01_main
NEXT_PUBLIC_CAMERA_1_NAME=Office Camera 1
NEXT_PUBLIC_CAMERA_1_LOCATION=NVR LAN
NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM=1.4
NEXT_PUBLIC_CAMERA_2_RTSP_URL=rtsp://127.0.0.1:8554/cam02_main
NEXT_PUBLIC_CAMERA_2_GO2RTC_SRC=cam02_main
NEXT_PUBLIC_CAMERA_2_NAME=Office Camera 2
NEXT_PUBLIC_CAMERA_2_LOCATION=NVR LAN
NEXT_PUBLIC_CAMERA_2_DIGITAL_ZOOM=1
NEXT_PUBLIC_ENABLE_WEBCAM_TILE=false
NEXT_PUBLIC_DETECTION_MODE=worker
```

Notes:
- `NEXT_PUBLIC_CAMERA_1_RTSP_URL` is consumed by the browser camera page through your `/api/stream` proxy.
- `NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC` is used by face detection snapshot proxy (`/api/camera/frame`) and should match go2rtc stream name.
- `NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM` / `NEXT_PUBLIC_CAMERA_2_DIGITAL_ZOOM` enable per-camera digital zoom (`>1` enables zoom, max `4`).
- `NEXT_PUBLIC_ENABLE_WEBCAM_TILE=true` enables the local webcam tile for debugging.
- `NEXT_PUBLIC_DETECTION_MODE=worker` disables browser face-api detection and shows worker live status under camera tiles.

## Node detection worker (browser-like)

The worker uses `@vladmandic/face-api` in Node and mirrors browser detection behavior.
At this stage it does not do matching and does not write to DB.

Run manually:

```bash
cp -n .env.worker.example .env.worker
node worker/node-detection-worker.mjs
```

## Server quick start (after git pull)

```bash
cd /opt/mood-checker
npm install
npm run build
cp -n .env.worker.example .env.worker
npm run pm2:start:all
npm run pm2:save
```

Verify:

```bash
pm2 logs mood-checker-pyworker --lines 80
```

Worker status API used by UI in worker mode:

```bash
curl -s "http://127.0.0.1:3000/api/worker/status?cameraId=cam-01"
```

Look for:
- `detector=face-api ...`
- `heartbeat: cameras_ready=... faces_detected=...`
- `[cam-01] face_detected count=...`

## PM2 (app + worker together)

```bash
npm run pm2:start:all
```

Useful commands:

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
npm run pm2:start       # app only
npm run pm2:start:pyworker
npm run pm2:restart:pyworker
npm run pm2:save
```
