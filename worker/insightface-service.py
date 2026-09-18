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
from urllib.parse import parse_qs, urlparse

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

import threading
import time

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
_ALLOW_SPINNING = os.getenv("WORKER_ONNX_ALLOW_SPINNING", "0").strip().lower() in ("1", "true", "yes", "on")


def _configure_session_options(options: "ort.SessionOptions", threads: int) -> None:
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = int(threads)
    # ORT's pool keeps its threads spinning after each op in case more work is
    # coming. On a 4-core box that must also decode H265 in real time, spinning
    # threads take cycles from ffmpeg between detections and the camera stream
    # answers with dropped or half-decoded (dark) frames. Blocking waits cost a
    # few microseconds of wake-up latency per op instead.
    if not _ALLOW_SPINNING:
        try:
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        except Exception:
            pass


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
            _configure_session_options(options, int(_threads))
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


def decode_image_from_bytes(data: bytes) -> np.ndarray | None:
    if not data:
        return None
    arr = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        return None
    return frame


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


def apply_crop(frame: np.ndarray, crop: dict) -> np.ndarray | None:
    """Cuts the window the worker is looking at out of the full frame (source pixels)."""
    try:
        x = int(crop.get("x") or 0)
        y = int(crop.get("y") or 0)
        w = int(crop.get("width") or 0)
        h = int(crop.get("height") or 0)
    except (TypeError, ValueError, AttributeError):
        return None
    frame_h, frame_w = frame.shape[:2]
    if w <= 0 or h <= 0:
        return frame
    if x <= 0 and y <= 0 and w >= frame_w and h >= frame_h:
        return frame
    x = max(0, min(frame_w - 1, x))
    y = max(0, min(frame_h - 1, y))
    w = max(1, min(frame_w - x, w))
    h = max(1, min(frame_h - y, h))
    return np.ascontiguousarray(frame[y : y + h, x : x + w])


_TIMING_LOCK = threading.Lock()
_TIMING = {"n": 0, "decode": 0.0, "decode_max": 0.0, "run": 0.0, "run_max": 0.0, "faces": 0, "last_log": time.monotonic()}
_TIMING_LOG_EVERY_S = max(2.0, float(os.getenv("WORKER_ANALYZE_TIMING_LOG_S", "10") or 10))
# Raw per-class probabilities, before the eight model classes are folded into
# seven keys. Rate limited; off unless asked for.
_EMOTION_RAW_DEBUG = os.getenv("WORKER_EMOTION_RAW_DEBUG", "0").strip().lower() in ("1", "true", "yes", "on")
_EMOTION_RAW_LOG_EVERY_S = max(0.2, float(os.getenv("WORKER_EMOTION_RAW_LOG_S", "1") or 1))
_EMOTION_RAW_LAST_LOG = 0.0


def record_timing(decode_ms: float, run_ms: float, faces: int, shape) -> None:
    """Rate-limited throughput line: where each /analyze call spends its time.

    "It does not keep up" is only answerable with these numbers: how many
    calls per second the service sustains, how much of each is JPEG decode and
    how much is the models. The worker's heartbeat prints the matching pass
    rate on its side.
    """
    with _TIMING_LOCK:
        stats = _TIMING
        stats["n"] += 1
        stats["decode"] += decode_ms
        stats["decode_max"] = max(stats["decode_max"], decode_ms)
        stats["run"] += run_ms
        stats["run_max"] = max(stats["run_max"], run_ms)
        stats["faces"] += faces
        now = time.monotonic()
        if now - stats["last_log"] < _TIMING_LOG_EVERY_S:
            return
        elapsed = max(1e-6, now - stats["last_log"])
        count = max(1, stats["n"])
        height, width = (int(shape[0]), int(shape[1])) if shape is not None and len(shape) >= 2 else (0, 0)
        log(
            f"analyze n={stats['n']} per_s={stats['n'] / elapsed:.1f} "
            f"decode_ms avg={stats['decode'] / count:.0f} max={stats['decode_max']:.0f} "
            f"run_ms avg={stats['run'] / count:.0f} max={stats['run_max']:.0f} "
            f"faces_avg={stats['faces'] / count:.2f} size={width}x{height}"
        )
        stats.update({"n": 0, "decode": 0.0, "decode_max": 0.0, "run": 0.0, "run_max": 0.0, "faces": 0, "last_log": now})


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
        # Replaced by the model's own input size once a session is created.
        self._input_size = EMOTION_INPUT_SIZE
        self._margin = max(0.0, min(0.6, env_float("WORKER_EMOTION_CROP_MARGIN", 0.1)))
        # Where the model's "Contempt" class goes. The UI has seven keys and the
        # model eight, so sharing "disgusted" with Disgust made it the only key
        # fed by two classes — a structural advantage, and Contempt is what a
        # downward camera reads off pressed lips. Measured on this camera while
        # holding known expressions (scripts/test-emotion-mapping.mjs replays
        # those readings): sharing matched the held expression in 7 of 15 frames
        # and turned every single smile into "disgusted"; dropping Contempt
        # matched 15 of 15 and left anger and sadness untouched. Set it to
        # "disgusted" or "neutral" to fold it back in.
        contempt = env_str("WORKER_EMOTION_CONTEMPT_MAP", "drop").strip().lower()
        if contempt in {"drop", "none", "ignore"}:
            self._contempt_target = ""
        elif contempt in FACEAPI_EMOTION_KEYS:
            self._contempt_target = contempt
        else:
            self._contempt_target = "disgusted"
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
            _configure_session_options(options, env_int("WORKER_ONNX_INTRA_THREADS", int(_threads)))
            providers = [
                part.strip()
                for part in env_str("WORKER_EMOTION_PROVIDERS", "CPUExecutionProvider").split(",")
                if part.strip()
            ] or ["CPUExecutionProvider"]
            self._session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=providers
            )
            model_input = self._session.get_inputs()[0]
            self._input_name = model_input.name
            # Input size comes from the model, not from its filename: the
            # HSEmotion family does not agree on one (enet_b0_8 takes 224,
            # enet_b2_8 takes 260). Feeding the wrong size either throws on a
            # fixed shape or silently returns nonsense on a dynamic one.
            self._input_size = EMOTION_INPUT_SIZE
            shape = list(getattr(model_input, "shape", []) or [])
            if len(shape) >= 2:
                dims = [d for d in shape[-2:] if isinstance(d, int) and d > 0]
                if len(dims) == 2 and dims[0] == dims[1]:
                    self._input_size = dims[0]
            self._model_path = str(model_path)
            bias_note = (
                " bias=" + ",".join(f"{k}={v:g}" for k, v in sorted(self._class_bias.items()))
                if self._class_bias
                else ""
            )
            log(
                f"emotion model loaded {model_path.name} input={self._input_size}px "
                f"providers={','.join(providers)}{bias_note}"
            )
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
            "emotionInputSize": getattr(self, "_input_size", None) if self.enabled else None,
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
        size = int(getattr(self, "_input_size", EMOTION_INPUT_SIZE) or EMOTION_INPUT_SIZE)
        resized = cv2.resize(crop, (size, size), interpolation=cv2.INTER_LINEAR)
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

        # The eight model classes become seven keys, and "disgusted" is the only
        # one fed by two of them (Contempt + Disgust). Summing is correct
        # probability arithmetic for "either", but it hands that key a structural
        # advantage no other key has — and Contempt is exactly the slightly
        # pressed lips a downward camera sees on a calm face. This log shows the
        # raw eight so the decision below rests on numbers.
        if _EMOTION_RAW_DEBUG:
            now_mono = time.monotonic()
            global _EMOTION_RAW_LAST_LOG
            if now_mono - _EMOTION_RAW_LAST_LOG >= _EMOTION_RAW_LOG_EVERY_S:
                _EMOTION_RAW_LAST_LOG = now_mono
                pairs = " ".join(
                    f"{label}={float(prob):.3f}" for label, prob in zip(HSEMOTION_LABELS, probs)
                )
                log(f"emotion_raw8 {pairs}")

        scores = {key: 0.0 for key in FACEAPI_EMOTION_KEYS}
        dropped = 0.0
        for label, prob in zip(HSEMOTION_LABELS, probs):
            target = self._contempt_target if label == "Contempt" else HSEMOTION_TO_FACEAPI[label]
            if target:
                scores[target] += float(prob)
            else:
                dropped += float(prob)
        # Renormalise what is left so the reported percentage still means "share
        # of this face", rather than silently shrinking by whatever was dropped.
        if dropped > 0:
            total = sum(scores.values())
            if total > 0:
                for key in scores:
                    scores[key] /= total

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

        # Binary path: the JPEG arrives as the raw body and the options come in
        # the query string. base64 inside JSON costs a third more bytes on the
        # wire plus a string encode on one side and a decode on the other, on
        # every frame — measurable when frames are ~600 KB and a pass is 220 ms.
        content_type = str(self.headers.get("Content-Type", "")).split(";")[0].strip().lower()
        if content_type == "application/octet-stream":
            query = parse_qs(urlparse(self.path).query)

            def q(name: str, default: str = "") -> str:
                values = query.get(name)
                return values[0] if values else default

            crop_arg = q("crop")
            crop_payload: Any = None
            if crop_arg:
                parts = crop_arg.split(",")
                if len(parts) == 4:
                    try:
                        crop_payload = {
                            "x": int(parts[0]),
                            "y": int(parts[1]),
                            "width": int(parts[2]),
                            "height": int(parts[3]),
                        }
                    except ValueError:
                        crop_payload = None
            payload = {
                "crop": crop_payload,
                "includeDescriptor": q("descriptor") == "1",
                "includeEmotions": q("emotions") == "1",
                "maxFaces": q("maxFaces", "10"),
                "minScore": q("minScore", "0"),
            }
            raw_image: bytes | None = raw_body
        else:
            raw_image = None
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
        decode_started = time.perf_counter()
        frame_bgr = None
        if raw_image:
            frame_bgr = decode_image_from_bytes(raw_image)
        elif image_base64:
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

        # The worker detects on a zoomed window of the frame but sends the JPEG
        # untouched (re-encoding it would cost quality and CPU), so the window is
        # applied here and every box, landmark and crop comes back in the
        # worker's own coordinates. Older workers send no crop and get the frame.
        crop = payload.get("crop")
        if isinstance(crop, dict):
            frame_bgr = apply_crop(frame_bgr, crop)
            if frame_bgr is None:
                self._json(400, {"error": "invalid_crop"})
                return

        include_descriptor = bool(payload.get("includeDescriptor", False))
        include_emotions = bool(payload.get("includeEmotions", False))
        max_faces = max(1, min(20, int(payload.get("maxFaces", 10) or 10)))
        min_score = max(0.0, min(1.0, float(payload.get("minScore", 0.0) or 0.0)))

        run_started = time.perf_counter()
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
        record_timing(
            (run_started - decode_started) * 1000.0,
            (time.perf_counter() - run_started) * 1000.0,
            len(faces) if isinstance(faces, list) else 0,
            getattr(frame_bgr, "shape", None),
        )

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
