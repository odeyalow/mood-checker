let modelsPromise: Promise<void> | null = null;
let matcherPromise: Promise<any | null> | null = null;
let recognitionReady = false;
const FACE_MATCH_DISTANCE = 0.52;

function mirrorImage(source: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function waitForGlobal(key: "faceapi" | "loadPlayer", timeoutMs = 15000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if ((window as any)[key]) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`${key} script timeout`));
      }
    }, 100);
  });
}

export async function ensureFaceApiReady() {
  await waitForGlobal("faceapi");
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const faceapi = (window as any).faceapi;
      await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
      await faceapi.nets.faceExpressionNet.loadFromUri("/models");
      try {
        await faceapi.nets.faceLandmark68TinyNet.loadFromUri("/models");
        await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
        recognitionReady = true;
      } catch (_err) {
        try {
          await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
          await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
          recognitionReady = true;
        } catch (_fallbackErr) {
          recognitionReady = false;
        }
      }
    })();
  }
  return modelsPromise;
}

export function isRecognitionReady() {
  return recognitionReady;
}

async function loadKnownFaces() {
  if (!recognitionReady) return null;
  const faceapi = (window as any).faceapi;
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: 416,
    scoreThreshold: 0.45,
  });
  const res = await fetch("/known/images.json");
  if (!res.ok) return null;
  const images = await res.json();
  if (!Array.isArray(images) || images.length === 0) return null;

  const labelMap = new Map<string, string[]>();
  images.forEach((file: string) => {
    const base = file.replace(/\.[^/.]+$/, "");
    const label = base.replace(/[-_]\d+$/, "");
    if (!label) return;
    if (!labelMap.has(label)) labelMap.set(label, []);
    labelMap.get(label)?.push(`/known/${encodeURIComponent(file)}`);
  });

  const labeledDescriptors = [];
  for (const [label, urls] of labelMap.entries()) {
    const descriptors = [];
    for (const url of urls) {
      const img = await faceapi.fetchImage(url);
      const samples = [img, mirrorImage(img)];
      for (const sample of samples) {
        const detection = await faceapi
          .detectSingleFace(sample, detectorOptions)
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if (detection) descriptors.push(detection.descriptor);
      }
    }
    if (descriptors.length) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(label, descriptors));
    }
  }

  if (!labeledDescriptors.length) return null;
  return new faceapi.FaceMatcher(labeledDescriptors, FACE_MATCH_DISTANCE);
}

export async function getFaceMatcher() {
  await ensureFaceApiReady();
  if (!matcherPromise) {
    matcherPromise = loadKnownFaces().catch(() => null);
  }
  return matcherPromise;
}

export async function ensureRtspPlayerReady() {
  await waitForGlobal("loadPlayer");
}
