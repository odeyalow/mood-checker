let modelsPromise: Promise<void> | null = null;
let matcherPromise: Promise<any | null> | null = null;
let recognitionReady = false;
const FACE_MATCH_DISTANCE = 0.55;

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
      await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
      await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
      await faceapi.nets.faceExpressionNet.loadFromUri("/models");
      try {
        await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
        await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
        recognitionReady = true;
      } catch (_err) {
        recognitionReady = false;
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
      const detection = await faceapi
        .detectSingleFace(
          img,
          new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 })
        )
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (detection) descriptors.push(detection.descriptor);
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
