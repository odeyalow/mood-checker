#!/usr/bin/env python3
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    known_dir = root / "public" / "known"
    files = sorted(
        [p for p in known_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    )

    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))

    loaded = 0
    for path in files:
        raw = np.fromfile(str(path), dtype=np.uint8)
        image = cv2.imdecode(raw, cv2.IMREAD_COLOR) if raw.size else None
        if image is None:
            faces = 0
        else:
            faces = len(app.get(image))
        print(f"{path.name}: faces={faces}")
        if faces > 0:
            loaded += 1

    print(f"loaded {loaded}/{len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
