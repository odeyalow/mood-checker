## Mood Checker

Next.js app with camera stream preview and face recognition events.

## Run app

```bash
npm install
npm run build
npm run start
```

### Camera source via go2rtc (recommended)

Set these in `.env` for the single camera setup:

```bash
NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC=cam01_main
NEXT_PUBLIC_CAMERA_1_NAME=Camera 1
NEXT_PUBLIC_CAMERA_1_LOCATION=10.16.12.39
NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM=1
NEXT_PUBLIC_CAMERA_1_FRAME_OFFSET_Y=0
NEXT_PUBLIC_ENABLE_WEBCAM_TILE=false
NEXT_PUBLIC_DETECTION_MODE=worker
GO2RTC_BASE_URL=http://127.0.0.1:1984
# Snapshot quality used by /api/camera/frame (worker input)
GO2RTC_FRAME_WIDTH=1280
GO2RTC_FRAME_HEIGHT=720
GO2RTC_FRAME_QUALITY=92
GO2RTC_FRAME_TIMEOUT_MS=3500
# Worker timeout fallback for unstable cameras
WORKER_FRAME_ABORT_RETRY_ENABLED=true
WORKER_FRAME_ABORT_RETRY_TIMEOUT_MS=2500
WORKER_FRAME_ABORT_RETRY_WIDTH=1280
WORKER_FRAME_ABORT_RETRY_HEIGHT=720
WORKER_FRAME_ABORT_RETRY_QUALITY=85
# Optional explicit worker override (otherwise worker inherits camera zoom from .env)
# WORKER_CAMERA_ZOOMS=cam-01=1
# Optional per-camera quality profiles
# WORKER_CAMERA_SETTINGS_JSON={"cam-01":{"matchThreshold":0.50,"frameOffsetY":0}}
# Re-entry writes a new recognition event when person reappears after short absence
# WORKER_DB_REENTRY_GAP_MS=1800
# Emotion fallback for weak confidence (prevents missing events in distance/zoom scenes)
# WORKER_EMOTION_LOW_CONFIDENCE_FLOOR=0.18
# WORKER_EMOTION_ALLOW_LOW_CONFIDENCE_LABEL=true
# WORKER_DB_ALLOW_MOOD_FALLBACK=true
# WORKER_DB_FALLBACK_MOOD=neutral
# Presence-session pipeline (no duplicate DB writes while person still in frame)
# WORKER_SESSION_SNAPSHOT_INTERVAL_MS=500
# WORKER_SESSION_ABSENCE_MS=3300
# WORKER_SESSION_RESOLVE_WAIT_MS=500
# WORKER_SESSION_MIN_SAMPLES=1
# WORKER_SESSION_MIN_EMOTION_SAMPLES=1
```

Notes:
- `NEXT_PUBLIC_CAMERA_1_GO2RTC_SRC` is the single source used by both UI preview and worker snapshots. Keep UI and worker on the same go2rtc stream name.
- `NEXT_PUBLIC_CAMERA_1_DIGITAL_ZOOM` and `NEXT_PUBLIC_CAMERA_1_FRAME_OFFSET_Y` define the shared framing used by both UI and worker. Positive `FRAME_OFFSET_Y` shifts the visible frame down and reveals more of the upper area.
- `GO2RTC_FRAME_WIDTH/HEIGHT/QUALITY` control snapshot resolution/quality for worker recognition (`/api/camera/frame`).
- `NEXT_PUBLIC_ENABLE_WEBCAM_TILE=true` enables the local webcam tile for debugging.
- `NEXT_PUBLIC_DETECTION_MODE=worker` disables browser-side face detection and shows worker live status under camera tiles.
- Recommended worker source:
  `WORKER_FRAME_API_BASE=http://127.0.0.1:1984/api/frame.jpeg?width=960&height=540&quality=82`

## Node detection worker

The worker keeps the existing Node orchestration/status pipeline, but uses a local `InsightFace`
backend for face detection and embeddings by default.
It performs face detection, identity matching against the face registry (`FaceIdentity` in DB),
auto-creates short face IDs for new people,
emotion extraction via compatibility fallback,
and async writes to `/api/recognitions` with retry queue.

By default the worker auto-starts `worker/insightface-service.py` from the local Python environment.
If that service is unavailable and `WORKER_INFERENCE_FALLBACK_FACEAPI=true`, the worker falls back to
the legacy `face-api` path.

Python backend prerequisites:

```bash
python -m venv .venv
python -m pip install -r worker/requirements-cpu.txt
```

Optional identity env (app process):
- `FACE_IDENTITY_ID_LENGTH=6` (`4..8`)
- `FACE_IDENTITY_MATCH_THRESHOLD=0.56`
- `FACE_IDENTITY_POSTCHECK_THRESHOLD=0.60` (optional, background duplicate cleanup threshold)
- `FACE_IDENTITY_DESCRIPTOR_ALPHA=0.2`

Face registry maintenance:
- `npm run faces:clear` - remove all registered faces and related snapshots/records.
- `npm run faces:delete -- <SHORT_ID>` - remove one registered face by short ID.

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
pm2 logs mood-checker-worker --lines 80
```

Apply balanced worker profile:

```bash
npm run worker:profile:balanced
pm2 restart mood-checker-worker --update-env
```

Restore pre-request profile (the values used before latest strict tuning):

```bash
npm run worker:profile:pre-request
pm2 restart mood-checker-worker --update-env
```

Run full worker diagnostics:

```bash
npm run worker:diagnose
```

Worker status API used by UI in worker mode:

```bash
curl -s "http://127.0.0.1:3000/api/worker/status?cameraId=cam-01"
```

Worker zoom API (camera-specific, does not affect UI stream):

```bash
curl -s -X POST "http://127.0.0.1:3000/api/worker/zoom" \
  -H "Content-Type: application/json" \
  -d '{"cameraId":"cam-01","zoom":1}'
```

Look for:
- `detector=insightface ...`
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
npm run pm2:start:worker
npm run pm2:restart:worker
npm run pm2:save
```
