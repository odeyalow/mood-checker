import { randomBytes } from "node:crypto";

const FACE_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FACE_ID_DEFAULT_LENGTH = 6;
const FACE_ID_MIN_LENGTH = 4;
const FACE_ID_MAX_LENGTH = 8;
const DESCRIPTOR_LENGTH = 128;

export function normalizeFaceIdLength(raw: number | null | undefined) {
  const value = Number(raw ?? FACE_ID_DEFAULT_LENGTH);
  if (!Number.isFinite(value)) return FACE_ID_DEFAULT_LENGTH;
  const rounded = Math.round(value);
  return Math.max(FACE_ID_MIN_LENGTH, Math.min(FACE_ID_MAX_LENGTH, rounded));
}

export function generateFaceShortId(length = FACE_ID_DEFAULT_LENGTH) {
  const size = normalizeFaceIdLength(length);
  const bytes = randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i += 1) {
    const idx = bytes[i] % FACE_ID_ALPHABET.length;
    out += FACE_ID_ALPHABET[idx];
  }
  return out;
}

export function normalizeDescriptor(input: unknown): number[] | null {
  if (!Array.isArray(input) || !input.length) return null;
  const values = input.map((raw) => Number(raw));
  if (values.some((v) => !Number.isFinite(v))) return null;
  if (values.length !== DESCRIPTOR_LENGTH) return null;
  return values;
}

export function descriptorDistance(a: number[], b: number[]) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Number(a[i]) - Number(b[i]);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function mergeDescriptor(base: number[], incoming: number[], alpha = 0.2) {
  if (!Array.isArray(base) || !Array.isArray(incoming) || base.length !== incoming.length) {
    return incoming;
  }
  const safeAlpha = Math.max(0.05, Math.min(0.95, Number(alpha) || 0.2));
  return base.map((value, index) =>
    Number(((1 - safeAlpha) * Number(value) + safeAlpha * Number(incoming[index])).toFixed(6)),
  );
}
