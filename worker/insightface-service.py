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

# Must be set BEFORE onnxruntime is imported: it reads these when it builds its
# thread pools. Without an explicit count ORT tries to pin each thread to a core
# with pthread_setaffinity_np, which a container with restricted CPU affinity
# refuses — producing a wall of "[E:onnxruntime] ... error code: 22" lines. The
# work still runs, unpinned; this just keeps the logs readable.
_threads = os.getenv("WORKER_ONNX_INTRA_THREADS", "").strip()
if not _threads or _threads == "0":
    _threads = str(max(1, len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)))
os.environ.setdefault("OMP_NUM_THREADS", _threads)
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")

import cv2
import numpy as np
import onnxruntime as ort

# InsightFace builds its own InferenceSessions and passes no SessionOptions, so
# every buffalo_l model leaves intra_op_num_threads at the default. ONNX Runtime
# then pins each worker thread to a core, which a container with restricted CPU
# affinity refuses — one "[E:onnxruntime] ... error code: 22" line per thread per
# model, drowning the real output in pm2 logs. Setting OMP_NUM_THREADS above is
# not enough: that governs OpenMP, not ORT's own pool.
#
# Wrapping the constructor is the only hook we have into sessions we do not
# create. The work still runs on the same number of threads — they are simply
# not pinned, which is exactly what the error message asks for.
_ORT_SESSION_CLS = ort.InferenceSession


class _ThreadPinnedSession(_ORT_SESSION_CLS):  # type: ignore[misc, valid-type]
    """InferenceSession that always carries an explicit intra-op thread count.

    Must stay a CLASS, not a factory function: insightface's model_zoo does
    `class PickableInferenceSession(onnxruntime.InferenceSession)`, so replacing
    the attribute with a function breaks the import outright.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # sess_options is the second positional parameter; only fill it in when
        # the caller left it out entirely.
        if len(args) < 2 and kwargs.get("sess_options") is None:
            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            options.intra_op_num_threads = int(_threads)
            kwargs["sess_options"] = options
        super().__init__(*args, **kwargs)


ort.InferenceSession = _ThreadPinnedSession


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


# HSEmotion (github.com/HSE-asavchenko/face-emotion-recognition) emits 8 AffectNet
# classes in this exact order. The rest of this project speaks face-api's 7-key
# vocabulary (see emotionKeys in node-detection-worker.mjs), so we fold the 8 into
# the 7 here and everything downstream — smoothing, strictness, classifyMood —
# keeps working untouched. "Contempt" has no face-api equivalent; it is folded into
# "disgusted", the nearest class, and both are negative for classifyMood anyway.
HSEMOTION_LABELS = (
    "Anger",
    "Contempt",
    "Disgust",
    "Fear",
    "Happiness",
    "Neutral",
    "Sadness",
    "Surprise",
)
HSEMOTION_TO_FACEAPI = {
    "Anger": "angry",
    "Contempt": "disgusted",
    "Disgust": "disgusted",
    "Fear": "fearful",
    "Happiness": "happy",
    "Neutral": "neutral",
    "Sadness": "sad",
    "Surprise": "surprised",
}
FACEAPI_EMOTION_KEYS = (
    "neutral",
    "happy",
    "sad",
    "angry",
    "fearful",
    "disgusted",
    "surprised",
)

# EfficientNet-B0 trained on AffectNet: 224x224 RGB, NCHW, ImageNet normalisation.
EMOTION_INPUT_SIZE = 224
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)


def parse_class_bias(raw: str) -> dict[str, float]:
    """Per-class multipliers, e.g. "neutral=1.4,sad=0.8".

    Emotion models carry a person-specific bias: a resting face with slightly
    down-turned mouth corners reads as mildly sad, and no amount of temporal
    smoothing fixes that because every frame agrees. Scaling the class scores
    moves the decision boundary instead. Run scripts/calibrate-emotion.mjs to
    get values measured from a real face rather than guessed.
    """
    bias: dict[str, float] = {}
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, _, value = part.partition("=")
        key = key.strip().lower()
        if key not in FACEAPI_EMOTION_KEYS:
            continue
        try:
            weight = float(value)
        except ValueError:
            continue
        if weight > 0:
            bias[key] = weight
    return bias


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits)
    exp = np.exp(shifted)
    total = exp.sum()
    if not np.isfinite(total) or total <= 0:
        return np.full(logits.shape, 1.0 / max(1, logits.size), dtype=np.float32)
    return (exp / total).astype(np.float32)


class EmotionEngine:
    """Runs HSEmotion directly on the already-detected face box.

    The previous pipeline cropped the face and then ran face-api's TinyFaceDetector
    *again* to re-find a face inside that crop (up to four detector passes per face)
    before classifying. The box is already known here, so classification is a single
    ONNX forward pass on the crop.
    """

    def __init__(self) -> None:
        self._session: Any = None
        self._input_name = ""
        self._lock = threading.Lock()
        self._model_path = ""
        self._margin = max(0.0, min(0.6, env_float("WORKER_EMOTION_CROP_MARGIN", 0.1)))
        self._class_bias = parse_class_bias(env_str("WORKER_EMOTION_CLASS_BIAS", ""))
        self._fail_logged = False

        if env_str("WORKER_EMOTION_BACKEND", "hsemotion").lower() in {"none", "off", "disabled"}:
            log("emotion backend disabled (WORKER_EMOTION_BACKEND)")
            return

        default_path = str(ROOT_DIR / "worker" / "models" / "enet_b0_8_best_afew.onnx")
        model_path = Path(env_str("WORKER_EMOTION_MODEL_PATH", default_path))
        if not model_path.exists():
            log(
                f"emotion model not found at {model_path} — emotions fall back to face-api. "
                "Run: node scripts/download-emotion-model.mjs"
            )
            return

        try:
            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            intra = env_int("WORKER_ONNX_INTRA_THREADS", int(_threads))
            if intra > 0:
                options.intra_op_num_threads = intra
            providers = [
                part.strip()
                for part in env_str("WORKER_EMOTION_PROVIDERS", "CPUExecutionProvider").split(",")
                if part.strip()
            ] or ["CPUExecutionProvider"]
            self._session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=providers
            )
            self._input_name = self._session.get_inputs()[0].name
            self._model_path = str(model_path)
            bias_note = (
                " bias=" + ",".join(f"{k}={v:g}" for k, v in sorted(self._class_bias.items()))
                if self._class_bias
                else ""
            )
            log(f"emotion model loaded {model_path.name} providers={','.join(providers)}{bias_note}")
        except Exception as exc:  # noqa: BLE001 - never let emotions break detection
            self._session = None
            log(f"emotion model failed to load err={exc} — emotions fall back to face-api")

    @property
    def enabled(self) -> bool:
        return self._session is not None

    @property
    def info(self) -> dict[str, Any]:
        return {
            "emotionModel": Path(self._model_path).name if self._model_path else None,
            "emotionEnabled": self.enabled,
            "emotionClassBias": self._class_bias or None,
        }

    def _preprocess(self, frame_bgr: np.ndarray, box: dict[str, float]) -> np.ndarray | None:
        height, width = frame_bgr.shape[:2]
        pad_x = box["width"] * self._margin
        pad_y = box["height"] * self._margin
        x1 = int(max(0, math.floor(box["x"] - pad_x)))
        y1 = int(max(0, math.floor(box["y"] - pad_y)))
        x2 = int(min(width, math.ceil(box["x"] + box["width"] + pad_x)))
        y2 = int(min(height, math.ceil(box["y"] + box["height"] + pad_y)))
        if x2 - x1 < 16 or y2 - y1 < 16:
            return None

        crop = frame_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        resized = cv2.resize(
            crop, (EMOTION_INPUT_SIZE, EMOTION_INPUT_SIZE), interpolation=cv2.INTER_LINEAR
        )
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        chw = np.transpose(rgb, (2, 0, 1))
        normalized = (chw - IMAGENET_MEAN) / IMAGENET_STD
        return normalized[np.newaxis, ...].astype(np.float32)

    def predict(self, frame_bgr: np.ndarray, box: dict[str, float]) -> dict[str, float] | None:
        if self._session is None:
            return None
        try:
            tensor = self._preprocess(frame_bgr, box)
            if tensor is None:
                return None
            with self._lock:
                outputs = self._session.run(None, {self._input_name: tensor})
            logits = np.asarray(outputs[0], dtype=np.float32).reshape(-1)
            if logits.size != len(HSEMOTION_LABELS):
                return None
            probs = softmax(logits)
        except Exception as exc:  # noqa: BLE001
            if not self._fail_logged:
                log(f"emotion inference failed err={exc}")
                self._fail_logged = True
            return None

        scores = {key: 0.0 for key in FACEAPI_EMOTION_KEYS}
        for label, prob in zip(HSEMOTION_LABELS, probs):
            scores[HSEMOTION_TO_FACEAPI[label]] += float(prob)

        if self._class_bias:
            for key, weight in self._class_bias.items():
                scores[key] *= weight
            total = sum(scores.values())
            if total > 0:
                for key in scores:
                    scores[key] /= total
        return scores


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

        det_thresh = env_float("WORKER_INSIGHTFACE_DET_THRESH", 0.5)

        self._lock = threading.Lock()
        # Only detection + recognition. A buffalo_* pack also ships 2d106det,
        # 1k3d68 and genderage; without allowed_modules FaceAnalysis.get() runs
        # all three on every detected face and this service throws the results
        # away — it returns nothing but box, 5-point kps and the embedding.
        self._app = FaceAnalysis(
            name=model_name,
            providers=providers,
            allowed_modules=["detection", "recognition"],
        )
        self._app.prepare(ctx_id=0, det_thresh=det_thresh, det_size=(det_size, det_size))
        self._model_name = model_name
        self._det_size = det_size
        self._det_thresh = det_thresh
        self._providers = providers
        self._descriptor_length = 0
        log(
            "loaded "
            + f"model={self._model_name} det_size={self._det_size} det_thresh={self._det_thresh} "
            + f"modules=detection,recognition providers={','.join(self._providers)}"
        )

    @property
    def info(self) -> dict[str, Any]:
        return {
            "model": self._model_name,
            "detSize": self._det_size,
            "detThresh": self._det_thresh,
            "providers": self._providers,
            "descriptorLength": self._descriptor_length,
        }

    def analyze(
        self,
        frame_bgr: np.ndarray,
        *,
        include_descriptor: bool,
        include_emotions: bool,
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

        # Classify only the faces actually being returned, after the max_faces cut.
        if include_emotions and EMOTIONS.enabled:
            for row in rows:
                expressions = EMOTIONS.predict(frame_bgr, row["box"])
                if expressions:
                    row["expressions"] = expressions

        return rows


ROOT_DIR = Path(__file__).resolve().parent.parent
load_env_file(ROOT_DIR / ".env.worker")
load_env_file(ROOT_DIR / ".env")

EMOTIONS = EmotionEngine()
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
            self._json(200, {"ok": True, **ENGINE.info, **EMOTIONS.info})
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
        # JPEG first: a 960x540 frame is ~150 KB as JPEG against ~1.5 MB as raw RGB
        # (~2 MB once base64-encoded), and cv2.imdecode costs only a few ms. Raw RGB
        # stays supported so an older worker keeps working against this service.
        frame_bgr = None
        if image_base64:
            frame_bgr = decode_image_from_base64(image_base64)
        elif rgb_base64:
            width = int(payload.get("width") or 0)
            height = int(payload.get("height") or 0)
            frame_bgr = decode_rgb_from_base64(rgb_base64, width, height)
        else:
            self._json(400, {"error": "image_required"})
            return

        if frame_bgr is None:
            self._json(400, {"error": "image_decode_failed"})
            return

        include_descriptor = bool(payload.get("includeDescriptor", False))
        include_emotions = bool(payload.get("includeEmotions", False))
        max_faces = max(1, min(20, int(payload.get("maxFaces", 10) or 10)))
        min_score = max(0.0, min(1.0, float(payload.get("minScore", 0.0) or 0.0)))

        try:
            faces = ENGINE.analyze(
                frame_bgr,
                include_descriptor=include_descriptor,
                include_emotions=include_emotions,
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
                **EMOTIONS.info,
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
