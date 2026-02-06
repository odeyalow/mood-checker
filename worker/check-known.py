#!/usr/bin/env python3
from pathlib import Path

import cv2
import numpy as np
import torch
from facenet_pytorch import MTCNN
from PIL import Image


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    known_dir = root / "public" / "known"
    files = sorted(
        [p for p in known_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    mtcnn = MTCNN(keep_all=True, device=device)

    loaded = 0
    for path in files:
        raw = np.fromfile(str(path), dtype=np.uint8)
        image = cv2.imdecode(raw, cv2.IMREAD_COLOR) if raw.size else None
        if image is None:
            faces = 0
        else:
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            boxes, _ = mtcnn.detect(pil)
            faces = 0 if boxes is None else len(boxes)
        print(f"{path.name}: faces={faces}")
        if faces > 0:
            loaded += 1

    print(f"loaded {loaded}/{len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
