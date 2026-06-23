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
        return rows


ROOT_DIR = Path(__file__).resolve().parent.parent
load_env_file(ROOT_DIR / ".env.worker")
load_env_file(ROOT_DIR / ".env")

ENGINE = InsightFaceEngine()


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
            self._json(200, {"ok": True, **ENGINE.info})
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
        max_faces = max(1, min(20, int(payload.get("maxFaces", 10) or 10)))
        min_score = max(0.0, min(1.0, float(payload.get("minScore", 0.0) or 0.0)))

        try:
            faces = ENGINE.analyze(
                frame_bgr,
                include_descriptor=include_descriptor,
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
