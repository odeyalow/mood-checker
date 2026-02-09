#!/usr/bin/env python3
"""
Detection-only RTSP worker.

Reads camera streams, detects faces, and logs detection events.
No matching and no DB writes in this stage.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import cv2


def log(message: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[py-detection-worker {ts}] {message}", flush=True)


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        os.environ.setdefault(key, _strip_quotes(value))


def getenv_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def getenv_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def parse_urls() -> List[str]:
    raw = os.getenv("WORKER_RTSP_URLS", "").strip()
    if raw:
        return [u.strip() for u in raw.split(",") if u.strip()]

    # Fallback to public camera envs if worker list is not provided.
    fallback: List[str] = []
    for key in (
        "NEXT_PUBLIC_CAMERA_1_RTSP_URL",
        "NEXT_PUBLIC_CAMERA_2_RTSP_URL",
        "NEXT_PUBLIC_CAMERA_3_RTSP_URL",
        "NEXT_PUBLIC_CAMERA_4_RTSP_URL",
    ):
        value = os.getenv(key, "").strip()
        if value:
            fallback.append(value)
    return fallback


class Detector:
    def __init__(self) -> None:
        self.mode = "haar"
        self._face_app = None
        self._haar = None
        self.min_score = getenv_float("WORKER_DET_MIN_SCORE", 0.45)
        self.min_side_ratio = getenv_float("WORKER_DET_MIN_SIDE_RATIO", 0.03)
        self.max_side_ratio = getenv_float("WORKER_DET_MAX_SIDE_RATIO", 0.82)
        self.min_aspect = getenv_float("WORKER_DET_MIN_ASPECT", 0.7)
        self.max_aspect = getenv_float("WORKER_DET_MAX_ASPECT", 1.5)

        preferred = os.getenv("WORKER_DETECTOR", "insightface").strip().lower()
        if preferred == "insightface":
            self._try_insightface()

        if self._face_app is None:
            self._init_haar()

    def _try_insightface(self) -> None:
        try:
            from insightface.app import FaceAnalysis  # type: ignore

            det_size = getenv_int("WORKER_DET_SIZE", 640)
            model_name = os.getenv("WORKER_MODEL_NAME", "buffalo_l").strip() or "buffalo_l"
            face_app = FaceAnalysis(
                name=model_name,
                providers=["CPUExecutionProvider"],
                allowed_modules=["detection"],
            )
            face_app.prepare(ctx_id=0, det_size=(det_size, det_size))
            self._face_app = face_app
            self.mode = "insightface"
            log(f"detector=insightface model={model_name} det_size={det_size}")
        except Exception as exc:  # pragma: no cover - runtime fallback
            log(f"insightface unavailable, fallback to haar: {exc}")
            self._face_app = None

    def _init_haar(self) -> None:
        haar_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(str(haar_path))
        if cascade.empty():
            raise RuntimeError(f"Failed to load Haar cascade at {haar_path}")
        self._haar = cascade
        self.mode = "haar"
        log("detector=haar")

    def detect(self, frame_bgr) -> List[Tuple[int, int, int, int]]:
        fh, fw = frame_bgr.shape[:2]
        min_side_px = max(20, int(min(fw, fh) * self.min_side_ratio))
        max_side_px = max(min_side_px, int(min(fw, fh) * self.max_side_ratio))
        if self._face_app is not None:
            faces = self._face_app.get(frame_bgr)
            boxes: List[Tuple[int, int, int, int]] = []
            for f in faces:
                bbox = getattr(f, "bbox", None)
                det_score = float(getattr(f, "det_score", 1.0))
                if bbox is None or len(bbox) != 4:
                    continue
                x1, y1, x2, y2 = [int(v) for v in bbox]
                w = max(0, x2 - x1)
                h = max(0, y2 - y1)
                aspect = w / float(max(h, 1))
                plausible_shape = self.min_aspect <= aspect <= self.max_aspect
                plausible_size = min_side_px <= max(w, h) <= max_side_px
                if w > 0 and h > 0 and det_score >= self.min_score and plausible_shape and plausible_size:
                    boxes.append((x1, y1, w, h))
            return boxes

        if self._haar is None:
            return []
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        detections = self._haar.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=6,
            minSize=(28, 28),
        )
        return [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in detections]


@dataclass
class CameraState:
    idx: int
    url: str
    cap: Optional[cv2.VideoCapture] = None
    frame_num: int = 0
    last_event_log: float = 0.0
    last_reconnect_log: float = 0.0
    last_open_attempt: float = 0.0

    @property
    def camera_id(self) -> str:
        return f"cam-{self.idx:02d}"

    def open(self) -> bool:
        self.close()
        self.cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        if self.cap is not None:
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok = bool(self.cap and self.cap.isOpened())
        return ok

    def close(self) -> None:
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
        self.cap = None


def resize_for_detection(frame, max_width: int):
    h, w = frame.shape[:2]
    if w <= max_width:
        return frame
    scale = max_width / float(w)
    nh = max(1, int(h * scale))
    return cv2.resize(frame, (max_width, nh), interpolation=cv2.INTER_AREA)


def run() -> int:
    root = Path(__file__).resolve().parent.parent
    load_env_file(root / ".env.worker")
    load_env_file(root / ".env")

    urls = parse_urls()
    if not urls:
        log("no camera URLs configured (WORKER_RTSP_URLS is empty)")
        return 1

    frame_stride = max(1, getenv_int("WORKER_FRAME_STRIDE", 1))
    heartbeat_seconds = max(1.0, getenv_float("WORKER_HEARTBEAT_SECONDS", 5.0))
    reconnect_delay_seconds = max(0.5, getenv_float("WORKER_RECONNECT_DELAY_SECONDS", 1.5))
    detection_log_cooldown = max(0.2, getenv_float("WORKER_DETECTION_LOG_COOLDOWN_SECONDS", 0.5))
    max_width = max(320, getenv_int("WORKER_MAX_WIDTH", 960))
    grab_flush = max(0, getenv_int("WORKER_GRAB_FLUSH", 1))

    detector = Detector()
    cams = [CameraState(idx=i + 1, url=url) for i, url in enumerate(urls)]
    log(f"started cameras={len(cams)} frame_stride={frame_stride} max_width={max_width}")

    last_heartbeat = 0.0

    try:
        while True:
            now = time.time()
            faces_total = 0
            ready = 0

            for cam in cams:
                if cam.cap is None or not cam.cap.isOpened():
                    if now - cam.last_open_attempt >= reconnect_delay_seconds:
                        cam.last_open_attempt = now
                        if cam.open():
                            log(f"[{cam.camera_id}] stream connected")
                        else:
                            if now - cam.last_reconnect_log >= 5.0:
                                log(f"[{cam.camera_id}] stream open failed, retrying")
                                cam.last_reconnect_log = now
                    continue

                ready += 1
                if cam.cap is not None and grab_flush > 0:
                    for _ in range(grab_flush):
                        cam.cap.grab()
                ok, frame = cam.cap.read()
                if not ok or frame is None:
                    if now - cam.last_reconnect_log >= 2.0:
                        log(f"[{cam.camera_id}] frame read failed, reconnecting")
                        cam.last_reconnect_log = now
                    cam.close()
                    continue

                cam.frame_num += 1
                if cam.frame_num % frame_stride != 0:
                    continue

                frame_for_det = resize_for_detection(frame, max_width=max_width)
                boxes = detector.detect(frame_for_det)
                count = len(boxes)
                faces_total += count

                if count > 0 and now - cam.last_event_log >= detection_log_cooldown:
                    log(f"[{cam.camera_id}] face_detected count={count}")
                    cam.last_event_log = now

            if now - last_heartbeat >= heartbeat_seconds:
                log(f"heartbeat: cameras_ready={ready}/{len(cams)} faces_detected={faces_total}")
                last_heartbeat = now

            time.sleep(0.03)
    except KeyboardInterrupt:
        log("stop signal received")
    finally:
        for cam in cams:
            cam.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
