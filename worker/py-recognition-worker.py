#!/usr/bin/env python3
import json
import os
import re
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from insightface.app import FaceAnalysis


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "y", "on")


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


def log(message: str) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[py-recognition-worker {now}] {message}", flush=True)


def decode_mojibake(filename: str) -> str:
    try:
        return filename.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return filename


def canonical_name(stem: str) -> str:
    return re.sub(r"[_-]\d+$", "", stem, flags=re.IGNORECASE)


def parse_cameras_from_ts(path: Path) -> List[Tuple[str, str]]:
    if not path.exists():
        return []
    body = path.read_text(encoding="utf-8")
    urls = re.findall(r'rtspUrl:\s*"([^"]+)"', body)
    ids = re.findall(r'id:\s*"([^"]+)"', body)
    cameras: List[Tuple[str, str]] = []
    for idx, url in enumerate(urls):
        cam_id = ids[idx] if idx < len(ids) else f"cam-{idx + 1:02d}"
        cameras.append((cam_id, url))
    return cameras


@dataclass
class Settings:
    base_url: str
    post_url: str
    known_dir: Path
    known_json: Path
    cameras_ts: Path
    similarity_threshold: float
    cooldown_seconds: int
    frame_stride: int
    max_width: int
    send_unknown: bool
    heartbeat_seconds: int
    http_timeout_seconds: int
    det_size: int
    model_name: str


def load_settings(project_root: Path) -> Settings:
    base_url = os.getenv("WORKER_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
    return Settings(
        base_url=base_url,
        post_url=f"{base_url}/api/recognitions",
        known_dir=project_root / "public" / "known",
        known_json=project_root / "public" / "known" / "images.json",
        cameras_ts=project_root / "src" / "lib" / "cameras.ts",
        similarity_threshold=env_float("WORKER_SIMILARITY_THRESHOLD", 0.30),
        cooldown_seconds=env_int("WORKER_COOLDOWN_SECONDS", 3),
        frame_stride=env_int("WORKER_FRAME_STRIDE", 2),
        max_width=env_int("WORKER_MAX_WIDTH", 960),
        send_unknown=env_bool("WORKER_SEND_UNKNOWN", False),
        heartbeat_seconds=env_int("WORKER_HEARTBEAT_SECONDS", 20),
        http_timeout_seconds=env_int("WORKER_HTTP_TIMEOUT_SECONDS", 5),
        det_size=env_int("WORKER_DET_SIZE", 640),
        model_name=os.getenv("WORKER_MODEL_NAME", "buffalo_l"),
    )


def list_known_files(settings: Settings) -> List[Path]:
    names: List[str] = []
    if settings.known_json.exists():
        try:
            data = json.loads(settings.known_json.read_text(encoding="utf-8"))
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, str) and item.strip():
                        names.append(decode_mojibake(item.strip()))
        except Exception as exc:
            log(f"failed to read images.json: {exc}")

    files: List[Path] = []
    for name in names:
        candidate = settings.known_dir / name
        if candidate.exists():
            files.append(candidate)

    if files:
        return files

    fallback: List[Path] = []
    for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
        fallback.extend(sorted(settings.known_dir.glob(ext)))
    return fallback


def load_image(path: Path) -> Optional[np.ndarray]:
    try:
        raw = np.fromfile(str(path), dtype=np.uint8)
        if raw.size == 0:
            return None
        return cv2.imdecode(raw, cv2.IMREAD_COLOR)
    except Exception:
        return None




def parse_rtsp_cameras(settings: Settings) -> List[Tuple[str, str]]:
    env_urls = os.getenv("WORKER_RTSP_URLS", "").strip()
    if env_urls:
        result: List[Tuple[str, str]] = []
        for idx, url in enumerate(env_urls.split(",")):
            value = url.strip()
            if value:
                result.append((f"cam-{idx + 1:02d}", value))
        if result:
            return result
    return parse_cameras_from_ts(settings.cameras_ts)




class CameraState:
    def __init__(self, cam_id: str, url: str):
        self.cam_id = cam_id
        self.url = url
        self.cap: Optional[cv2.VideoCapture] = None
        self.frame_no = 0

    def connect(self) -> bool:
        if self.cap is not None:
            self.cap.release()
        self.cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        try:
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        ok = bool(self.cap.isOpened())
        if ok:
            log(f"[{self.cam_id}] stream connected")
        return ok

    def read(self) -> Optional[np.ndarray]:
        if self.cap is None and not self.connect():
            return None
        assert self.cap is not None
        ok, frame = self.cap.read()
        if not ok or frame is None:
            log(f"[{self.cam_id}] frame read failed, reconnecting")
            self.connect()
            return None
        self.frame_no += 1
        return frame


def resize_for_inference(frame: np.ndarray, max_width: int) -> np.ndarray:
    h, w = frame.shape[:2]
    if w <= max_width:
        return frame
    scale = max_width / float(w)
    target = (max_width, int(h * scale))
    return cv2.resize(frame, target, interpolation=cv2.INTER_AREA)


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    load_env_file(project_root / ".env.worker")
    settings = load_settings(project_root)

    cameras = parse_rtsp_cameras(settings)
    if not cameras:
        log("no RTSP cameras configured")
        return 1

    app = FaceAnalysis(name=settings.model_name, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(settings.det_size, settings.det_size))

    cam_states = [CameraState(cam_id, url) for cam_id, url in cameras]

    should_stop = False

    def _stop_handler(_sig: int, _frame: object) -> None:
        nonlocal should_stop
        should_stop = True
        log("stop signal received")

    signal.signal(signal.SIGINT, _stop_handler)
    signal.signal(signal.SIGTERM, _stop_handler)

    for camera in cam_states:
        camera.connect()

    last_heartbeat = 0.0
    last_detection_log = 0.0
    min_det_score = 0.6
    min_face_size = 40
    min_aspect = 0.6
    max_aspect = 1.6

    while not should_stop:
        ready = 0
        faces_detected = 0
        for camera in cam_states:
            frame = camera.read()
            if frame is None:
                continue
            ready += 1
            if camera.frame_no % settings.frame_stride != 0:
                continue

            frame = resize_for_inference(frame, settings.max_width)
            faces = app.get(frame)
            if not faces:
                continue
            filtered_faces = []
            for face in faces:
                score = float(getattr(face, "det_score", 0.0))
                if score < min_det_score:
                    continue
                x1, y1, x2, y2 = face.bbox.tolist()
                w = max(0.0, x2 - x1)
                h = max(0.0, y2 - y1)
                if w < min_face_size or h < min_face_size:
                    continue
                if h == 0:
                    continue
                aspect = w / h
                if aspect < min_aspect or aspect > max_aspect:
                    continue
                filtered_faces.append(face)
            if not filtered_faces:
                continue
            faces_detected += len(filtered_faces)
            now = time.time()
            if now - last_detection_log >= 0.2:
                log(f"[{camera.cam_id}] detected_faces={len(filtered_faces)}")
                last_detection_log = now

        now = time.time()
        if now - last_heartbeat >= settings.heartbeat_seconds:
            log(f"heartbeat: cameras_ready={ready}/{len(cam_states)} faces_detected={faces_detected}")
            last_heartbeat = now

        time.sleep(0.02)

    for camera in cam_states:
        if camera.cap is not None:
            camera.cap.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
