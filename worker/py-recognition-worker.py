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
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

import cv2
import numpy as np
import requests
import torch
from facenet_pytorch import InceptionResnetV1, MTCNN
from PIL import Image


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


class FaceNetRecognizer:
    def __init__(self) -> None:
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.mtcnn = MTCNN(keep_all=True, device=self.device)
        self.resnet = InceptionResnetV1(pretrained="vggface2").eval().to(self.device)

    def _image_to_pil(self, image: np.ndarray) -> Image.Image:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)

    def detect_faces(self, image: np.ndarray) -> Tuple[List[np.ndarray], List[Tuple[float, float, float, float]]]:
        pil = self._image_to_pil(image)
        boxes, _ = self.mtcnn.detect(pil)
        if boxes is None or len(boxes) == 0:
            return [], []
        faces = self.mtcnn.extract(pil, boxes, save_path=None)
        if faces is None:
            return [], []
        embeddings: List[np.ndarray] = []
        bboxes: List[Tuple[float, float, float, float]] = []
        with torch.no_grad():
            for idx in range(faces.shape[0]):
                face = faces[idx].unsqueeze(0).to(self.device)
                emb = self.resnet(face).cpu().numpy().flatten()
                norm = np.linalg.norm(emb)
                if norm == 0:
                    continue
                embeddings.append(emb / norm)
                x1, y1, x2, y2 = boxes[idx].tolist()
                bboxes.append((x1, y1, x2, y2))
        return embeddings, bboxes


def bbox_iou(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter == 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def crop_face(frame: np.ndarray, box: Tuple[float, float, float, float]) -> Optional[np.ndarray]:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    x1_i = max(0, int(x1))
    y1_i = max(0, int(y1))
    x2_i = min(w, int(x2))
    y2_i = min(h, int(y2))
    if x2_i <= x1_i or y2_i <= y1_i:
        return None
    return frame[y1_i:y2_i, x1_i:x2_i]


def blur_score(face: np.ndarray) -> float:
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def load_known_embeddings(settings: Settings, recognizer: FaceNetRecognizer) -> Dict[str, np.ndarray]:
    buckets: Dict[str, List[np.ndarray]] = {}
    for file_path in list_known_files(settings):
        image = load_image(file_path)
        if image is None:
            log(f"known skipped (decode failed): {file_path.name}")
            continue
        embeddings, boxes = recognizer.detect_faces(image)
        if not embeddings:
            log(f"known skipped (no face): {file_path.name}")
            continue
        best_idx = 0
        best_area = -1.0
        for idx, (x1, y1, x2, y2) in enumerate(boxes):
            area = float((x2 - x1) * (y2 - y1))
            if area > best_area:
                best_area = area
                best_idx = idx
        name = canonical_name(file_path.stem)
        buckets.setdefault(name, []).append(embeddings[best_idx])
        log(f"known loaded: {file_path.name}")
    known: Dict[str, np.ndarray] = {}
    for name, embeddings in buckets.items():
        mean = np.mean(np.stack(embeddings), axis=0)
        norm = np.linalg.norm(mean)
        if norm == 0:
            continue
        known[name] = mean / norm
    log(f"known embeddings loaded: {len(known)}")
    return known


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


def best_match(face_embedding: np.ndarray, known: Dict[str, np.ndarray]) -> Tuple[str, float, float]:
    if not known:
        return ("unknown", 0.0, -1.0)
    best_name = "unknown"
    best_score = -1.0
    second_score = -1.0
    for name, embedding in known.items():
        score = float(np.dot(face_embedding, embedding))
        if score > best_score:
            second_score = best_score
            best_score = score
            best_name = name
        elif score > second_score:
            second_score = score
    return best_name, best_score, second_score


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


def post_recognition(
    session: requests.Session, settings: Settings, name: str, mood: str, cam_id: str
) -> None:
    payload = {
        "name": name,
        "mood": mood,
        "detectedAt": datetime.now(timezone.utc).isoformat(),
        "cameraId": cam_id,
    }
    response = session.post(settings.post_url, json=payload, timeout=settings.http_timeout_seconds)
    response.raise_for_status()


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    load_env_file(project_root / ".env.worker")
    settings = load_settings(project_root)

    cameras = parse_rtsp_cameras(settings)
    if not cameras:
        log("no RTSP cameras configured")
        return 1

    recognizer = FaceNetRecognizer()
    known = load_known_embeddings(settings, recognizer)
    cam_states = [CameraState(cam_id, url) for cam_id, url in cameras]
    last_sent_at: Dict[str, float] = {}
    session = requests.Session()

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
    min_margin = 0.04
    min_face_size = 40
    min_blur = 10.0
    track_iou_threshold = 0.3
    track_ttl = 1.5
    max_track_embeddings = 5
    next_track_id = 1
    tracks: Dict[int, Dict[str, object]] = {}
    queue: Deque[Tuple[str, np.ndarray, float]] = deque()
    queue_max = 150
    track_enqueue_interval = 0.7
    min_track_frames = 3
    process_per_loop = 3

    while not should_stop:
        ready = 0
        faces_detected = 0
        faces_filtered = 0
        for camera in cam_states:
            frame = camera.read()
            if frame is None:
                continue
            ready += 1
            if camera.frame_no % settings.frame_stride != 0:
                continue

            frame = resize_for_inference(frame, settings.max_width)
            embeddings, boxes = recognizer.detect_faces(frame)
            if not embeddings:
                continue
            faces_detected += len(embeddings)

            now = time.time()

            # assign to tracks
            assigned: Dict[int, int] = {}
            for idx, box in enumerate(boxes):
                best_track = -1
                best_iou = 0.0
                for track_id, track in tracks.items():
                    if track["cam_id"] != camera.cam_id:
                        continue
                    iou = bbox_iou(box, track["bbox"])
                    if iou > best_iou:
                        best_iou = iou
                        best_track = track_id
                if best_track >= 0 and best_iou >= track_iou_threshold:
                    assigned[idx] = best_track
                else:
                    track_id = next_track_id
                    next_track_id += 1
                    tracks[track_id] = {
                        "cam_id": camera.cam_id,
                        "bbox": box,
                        "last_seen": now,
                        "embeddings": [],
                        "last_enqueued": 0.0,
                    }
                    assigned[idx] = track_id

            # update tracks with new embeddings and enqueue averaged snapshots
            for idx, face_embedding in enumerate(embeddings):
                box = boxes[idx]
                track = tracks[assigned[idx]]
                track["bbox"] = box
                track["last_seen"] = now

                face_crop = crop_face(frame, box)
                if face_crop is None:
                    continue
                h, w = face_crop.shape[:2]
                if min(h, w) < min_face_size:
                    faces_filtered += 1
                    continue
                if blur_score(face_crop) < min_blur:
                    faces_filtered += 1
                    continue

                embeddings_list: List[np.ndarray] = track["embeddings"]  # type: ignore[assignment]
                embeddings_list.append(face_embedding)
                if len(embeddings_list) > max_track_embeddings:
                    embeddings_list.pop(0)
                track["embeddings"] = embeddings_list

                last_enqueued = float(track.get("last_enqueued", 0.0))
                if len(embeddings_list) >= min_track_frames and (now - last_enqueued) >= track_enqueue_interval:
                    mean = np.mean(np.stack(embeddings_list), axis=0)
                    norm = np.linalg.norm(mean)
                    if norm > 0:
                        avg_embedding = mean / norm
                        if len(queue) < queue_max:
                            queue.append((camera.cam_id, avg_embedding, now))
                            track["last_enqueued"] = now
                            log(f"[{camera.cam_id}] queued snapshot for matching")
                        track["embeddings"] = []

            # cleanup old tracks
            stale = [tid for tid, t in tracks.items() if now - float(t["last_seen"]) > track_ttl]
            for tid in stale:
                del tracks[tid]

        # process queued snapshots
        processed = 0
        while queue and processed < process_per_loop:
            cam_id, embedding, ts = queue.popleft()
            name, score, second_score = best_match(embedding, known)
            is_known = score >= settings.similarity_threshold and (score - second_score) >= min_margin
            label = name if is_known else "unknown"
            if label == "unknown" and not settings.send_unknown:
                log(f"[{cam_id}] match=unknown score={score:.3f} (skipped)")
                processed += 1
                continue

            key = f"{cam_id}:{label}"
            now = time.time()
            if now - last_sent_at.get(key, 0.0) < settings.cooldown_seconds:
                processed += 1
                continue
            last_sent_at[key] = now

            try:
                log(f"[{cam_id}] match name={label} score={score:.3f} sending")
                post_recognition(session, settings, label, "neutral", cam_id)
                log(f"[{cam_id}] sent name={label} score={score:.3f}")
            except Exception as exc:
                log(f"send failed error={exc}")
            processed += 1

        now = time.time()
        if now - last_heartbeat >= settings.heartbeat_seconds:
            log(
                f"heartbeat: cameras_ready={ready}/{len(cam_states)} faces_detected={faces_detected} filtered={faces_filtered}"
            )
            last_heartbeat = now

        time.sleep(0.02)

    for camera in cam_states:
        if camera.cap is not None:
            camera.cap.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
