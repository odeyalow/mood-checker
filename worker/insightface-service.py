#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import math
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def log(message: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[insightface-service {ts}] {message}", flush=True)


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_env_file(path: Path, *, override: bool = False) -> None:
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
        if override or key not in os.environ:
            os.environ[key] = _strip_quotes(value)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def env_str(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


def decode_image_from_base64(raw: str) -> np.ndarray | None:
    payload = raw.strip()
    if not payload:
        return None
    if "," in payload:
        payload = payload.split(",")[-1]
    try:
        data = base64.b64decode(payload)
    except Exception:
        return None
    if not data:
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        return None
    return frame


def decode_rgb_from_base64(raw: str, width: int, height: int) -> np.ndarray | None:
    payload = raw.strip()
    if not payload or width <= 0 or height <= 0:
        return None
    try:
        data = base64.b64decode(payload)
    except Exception:
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    expected = width * height * 3
    if arr.size != expected:
        return None
    frame_rgb = arr.reshape((height, width, 3))
    return cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)


def normalize_embedding(face: Any) -> list[float] | None:
    embedding = getattr(face, "normed_embedding", None)
    if embedding is None:
        embedding = getattr(face, "embedding", None)
    if embedding is None:
        return None
    arr = np.asarray(embedding, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return None
    norm = np.linalg.norm(arr)
    if not np.isfinite(norm) or norm <= 0:
        return None
    arr = arr / norm
    return [float(x) for x in arr.tolist()]


def box_from_face(face: Any) -> dict[str, float] | None:
    bbox = getattr(face, "bbox", None)
    if bbox is None or len(bbox) != 4:
        return None
    x1, y1, x2, y2 = [float(v) for v in bbox]
    width = max(0.0, x2 - x1)
    height = max(0.0, y2 - y1)
    if width <= 0 or height <= 0:
        return None
    return {
        "x": x1,
        "y": y1,
        "width": width,
        "height": height,
    }


def landmarks_from_face(face: Any) -> dict[str, list[dict[str, float]]]:
    empty = {"leftEye": [], "rightEye": [], "nose": [], "leftMouth": [], "rightMouth": []}
    kps = getattr(face, "kps", None)
    if kps is None:
        return empty

    arr = np.asarray(kps, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[0] < 3 or arr.shape[1] < 2:
        return empty

    def point(index: int) -> list[dict[str, float]]:
        if index >= arr.shape[0]:
            return []
        return [{"x": float(arr[index][0]), "y": float(arr[index][1])}]

    # InsightFace kps order: 0 left eye, 1 right eye, 2 nose, 3 left mouth, 4 right mouth.
    return {
        "leftEye": point(0),
        "rightEye": point(1),
        "nose": point(2),
        "leftMouth": point(3),
        "rightMouth": point(4),
    }


# HSEmotion (enet_b0_8) class order -> face-api compatible keys used by the worker.
# Contempt (idx 1) has no face-api equivalent; folded into "disgusted".
HSEMOTION_IDX_TO_FACEAPI = [
    "angry",      # 0 Anger
    "disgusted",  # 1 Contempt
    "disgusted",  # 2 Disgust
    "fearful",    # 3 Fear
    "happy",      # 4 Happiness
    "neutral",    # 5 Neutral
    "sad",        # 6 Sadness
    "surprised",  # 7 Surprise
]


def crop_face_rgb(frame_bgr: np.ndarray, box: dict[str, float], pad_ratio: float = 0.2) -> np.ndarray | None:
    height, width = frame_bgr.shape[:2]
    bx = float(box.get("x", 0.0))
    by = float(box.get("y", 0.0))
    bw = float(box.get("width", 0.0))
    bh = float(box.get("height", 0.0))
    pad_x = bw * pad_ratio
    pad_y = bh * pad_ratio
    x0 = max(0, int(bx - pad_x))
    y0 = max(0, int(by - pad_y))
    x1 = min(width, int(bx + bw + pad_x))
    y1 = min(height, int(by + bh + pad_y))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    crop_bgr = frame_bgr[y0:y1, x0:x1]
    if crop_bgr.size == 0:
        return None
    return cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)


class EmotionEngine:
    def __init__(self) -> None:
        from hsemotion_onnx.facial_emotions import HSEmotionRecognizer  # type: ignore

        model_name = env_str("WORKER_HSEMOTION_MODEL", "enet_b0_8_best_afew")
        self._fer = HSEmotionRecognizer(model_name=model_name)
        self._model_name = model_name
        self._lock = threading.Lock()

    @property
    def model_name(self) -> str:
        return self._model_name

    def predict(self, face_rgb: np.ndarray) -> dict[str, float] | None:
        with self._lock:
            _, scores = self._fer.predict_emotions(face_rgb, logits=False)
        arr = np.asarray(scores, dtype=np.float32).reshape(-1)
        if arr.size < len(HSEMOTION_IDX_TO_FACEAPI):
            return None
        out: dict[str, float] = {}
        for idx, key in enumerate(HSEMOTION_IDX_TO_FACEAPI):
            out[key] = out.get(key, 0.0) + float(arr[idx])
        return out


def load_emotion_engine() -> "EmotionEngine | None":
    backend = env_str("WORKER_EMOTION_BACKEND", "hsemotion").lower()
    if backend in {"", "none", "off", "0", "false", "faceapi"}:
        log("emotion backend disabled in service (WORKER_EMOTION_BACKEND); worker uses face-api fallback")
        return None
    try:
        engine = EmotionEngine()
        log(f"emotion engine loaded backend=hsemotion model={engine.model_name}")
        return engine
    except Exception as exc:  # noqa: BLE001 - degrade gracefully to face-api path
        log(f"emotion engine unavailable (fallback to face-api) err={exc}")
        return None


class InsightFaceEngine:
    def __init__(self) -> None:
        from insightface.app import FaceAnalysis  # type: ignore

        model_name = env_str("WORKER_INSIGHTFACE_MODEL", env_str("WORKER_MODEL_NAME", "buffalo_l"))
        det_size = env_int("WORKER_INSIGHTFACE_DET_SIZE", env_int("WORKER_DET_SIZE", 960))
        provider_names = env_str(
            "WORKER_INSIGHTFACE_PROVIDERS",
            "CPUExecutionProvider",
        )
        providers = [part.strip() for part in provider_names.split(",") if part.strip()]
        if not providers:
            providers = ["CPUExecutionProvider"]

        self._lock = threading.Lock()
        self._app = FaceAnalysis(name=model_name, providers=providers)
        self._app.prepare(ctx_id=0, det_size=(det_size, det_size))
        self._model_name = model_name
        self._det_size = det_size
        self._providers = providers
        self._descriptor_length = 0
        log(
            "loaded "
            + f"model={self._model_name} det_size={self._det_size} "
            + f"providers={','.join(self._providers)}"
        )

    @property
    def info(self) -> dict[str, Any]:
        return {
            "model": self._model_name,
            "detSize": self._det_size,
            "providers": self._providers,
            "descriptorLength": self._descriptor_length,
        }

    def analyze(
        self,
        frame_bgr: np.ndarray,
        *,
        include_descriptor: bool,
        include_emotion: bool,
        max_faces: int,
        min_score: float,
    ) -> list[dict[str, Any]]:
        with self._lock:
            faces = self._app.get(frame_bgr)

        rows: list[dict[str, Any]] = []
        for face in faces:
            score = float(getattr(face, "det_score", 0.0) or 0.0)
            if score < min_score:
                continue
            box = box_from_face(face)
            if not box:
                continue

            descriptor = normalize_embedding(face) if include_descriptor else None
            if descriptor and not self._descriptor_length:
                self._descriptor_length = len(descriptor)

            rows.append(
                {
                    "score": score,
                    "box": box,
                    "landmarks": landmarks_from_face(face),
                    "descriptor": descriptor,
                }
            )

        rows.sort(key=lambda item: float(item.get("score", 0.0)), reverse=True)
        if max_faces > 0:
            rows = rows[:max_faces]

        # Emotion inference runs only on the kept faces, after truncation, to save compute.
        if include_emotion and EMOTION_ENGINE is not None:
            for row in rows:
                try:
                    face_rgb = crop_face_rgb(frame_bgr, row["box"])
                    row["expressions"] = EMOTION_ENGINE.predict(face_rgb) if face_rgb is not None else None
                except Exception:  # noqa: BLE001 - never let emotion failure break detection
                    row["expressions"] = None

        return rows


ROOT_DIR = Path(__file__).resolve().parent.parent
load_env_file(ROOT_DIR / ".env.worker")
load_env_file(ROOT_DIR / ".env")

ENGINE = InsightFaceEngine()
EMOTION_ENGINE = load_emotion_engine()


class Handler(BaseHTTPRequestHandler):
    server_version = "InsightFaceService/1.0"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            emotion_info = (
                {"backend": "hsemotion", "model": EMOTION_ENGINE.model_name}
                if EMOTION_ENGINE is not None
                else {"backend": "faceapi"}
            )
            self._json(200, {"ok": True, **ENGINE.info, "emotion": emotion_info})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if not self.path.startswith("/analyze"):
            self._json(404, {"error": "not_found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw_body = self.rfile.read(max(0, content_length))

        try:
            payload = json.loads(raw_body.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"error": "invalid_json"})
            return

        image_base64 = str(payload.get("imageBase64") or "").strip()
        rgb_base64 = str(payload.get("rgbBase64") or "").strip()
        frame_bgr = None
        if rgb_base64:
            width = int(payload.get("width") or 0)
            height = int(payload.get("height") or 0)
            frame_bgr = decode_rgb_from_base64(rgb_base64, width, height)
        elif image_base64:
            frame_bgr = decode_image_from_base64(image_base64)
        else:
            self._json(400, {"error": "image_required"})
            return

        if frame_bgr is None:
            self._json(400, {"error": "image_decode_failed"})
            return

        include_descriptor = bool(payload.get("includeDescriptor", False))
        include_emotion = bool(payload.get("includeEmotion", False))
        max_faces = max(1, min(20, int(payload.get("maxFaces", 10) or 10)))
        min_score = max(0.0, min(1.0, float(payload.get("minScore", 0.0) or 0.0)))

        try:
            faces = ENGINE.analyze(
                frame_bgr,
                include_descriptor=include_descriptor,
                include_emotion=include_emotion,
                max_faces=max_faces,
                min_score=min_score,
            )
        except Exception as exc:
            log(f"analyze failed err={exc}")
            self._json(500, {"error": "analyze_failed"})
            return

        self._json(
            200,
            {
                "ok": True,
                "faces": faces,
                **ENGINE.info,
            },
        )


def main() -> int:
    host = env_str("WORKER_INSIGHTFACE_HOST", "127.0.0.1")
    port = env_int("WORKER_INSIGHTFACE_PORT", 8765)
    server = ThreadingHTTPServer((host, port), Handler)
    log(f"listening http://{host}:{port}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
