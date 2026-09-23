import { randomBytes } from "node:crypto";

const FACE_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FACE_ID_DEFAULT_LENGTH = 6;
const FACE_ID_MIN_LENGTH = 4;
const FACE_ID_MAX_LENGTH = 8;
const SUPPORTED_DESCRIPTOR_LENGTHS = new Set([128, 512]);

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
  if (!SUPPORTED_DESCRIPTOR_LENGTHS.has(values.length)) return null;
  return values;
}

export function descriptorDistance(a: number[], b: number[]) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return Number.POSITIVE_INFINITY;
  }
  if (a.length === 512) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const av = Number(a[i]);
      const bv = Number(b[i]);
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    if (!Number.isFinite(dot) || normA <= 0 || normB <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const cosine = dot / Math.sqrt(normA * normB);
    return Number((1 - cosine).toFixed(6));
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Number(a[i]) - Number(b[i]);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function envNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Multi-descriptor templates.
 *
 * One vector per identity cannot represent a face seen from several angles: the
 * EMA in mergeDescriptor pulls it toward the average of every pose ever seen,
 * which matches none of them well. A template keeps a handful of distinct
 * vectors instead and matches against the closest one.
 */
export const FACE_TEMPLATE_MAX = envNumber(process.env.FACE_TEMPLATE_MAX, 8, 1, 32);
// A new vector is only worth storing if it differs from what we already have;
// otherwise a single pass in front of the camera fills the template with copies.
// Raise it to keep the template sparser, lower it to capture finer variation.
export const FACE_TEMPLATE_MIN_SPREAD = envNumber(
  process.env.FACE_TEMPLATE_MIN_SPREAD,
  0.15,
  0,
  0.8,
);
/**
 * How far a pose may sit from the identity's own primary vector.
 *
 * Only a lower bound existed, so a template could stretch without limit: one
 * real identity ended up holding vectors 0.70 apart — the match threshold
 * itself — and matching is min-over-members, so its reach grew with every
 * addition until a stranger passing "between" two of its poses fell inside the
 * threshold of both. Genuine angles of one face stay within ~0.55 of the
 * primary here, so anything beyond that widens reach without adding coverage.
 */
export const FACE_TEMPLATE_MAX_SPREAD = envNumber(
  process.env.FACE_TEMPLATE_MAX_SPREAD,
  0.55,
  0.2,
  1,
);

export function normalizeDescriptorList(input: unknown): number[][] {
  if (!Array.isArray(input)) return [];
  const out: number[][] = [];
  for (const item of input) {
    const descriptor = normalizeDescriptor(item);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

/** Distance from a probe to the closest member of a template. */
export function templateDistance(template: number[][], probe: number[]) {
  let min = Number.POSITIVE_INFINITY;
  for (const known of template) {
    const distance = descriptorDistance(known, probe);
    if (Number.isFinite(distance) && distance < min) min = distance;
  }
  return min;
}

/** Index of the member that carries the least unique information. */
function mostRedundantIndex(template: number[][]) {
  let worstIndex = 0;
  let worstDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < template.length; i += 1) {
    let nearest = Number.POSITIVE_INFINITY;
    for (let j = 0; j < template.length; j += 1) {
      if (i === j) continue;
      const distance = descriptorDistance(template[i], template[j]);
      if (Number.isFinite(distance) && distance < nearest) nearest = distance;
    }
    if (nearest < worstDistance) {
      worstDistance = nearest;
      worstIndex = i;
    }
  }
  return worstIndex;
}

/**
 * Returns the template to store, or null when `incoming` adds nothing.
 * A full template evicts its most redundant member rather than the oldest, so
 * repeatedly seeing one pose cannot push out the others.
 */
export function addToTemplate(
  template: number[][],
  incoming: number[],
  {
    max = FACE_TEMPLATE_MAX,
    minSpread = FACE_TEMPLATE_MIN_SPREAD,
    maxSpread = FACE_TEMPLATE_MAX_SPREAD,
    primary,
  }: { max?: number; minSpread?: number; maxSpread?: number; primary?: number[] } = {},
): number[][] | null {
  const safe = normalizeDescriptor(incoming);
  if (!safe) return null;
  const current = template.filter((item) => item.length === safe.length);
  if (!current.length) return [safe];

  if (templateDistance(current, safe) < minSpread) return null;
  // The identity's primary vector is the anchor: a pose belongs to THIS face
  // only if it stays near it. Without this the template drifts outward one
  // addition at a time, each one legitimate against its predecessor. Falls back
  // to the first member when no primary is supplied.
  const anchor = normalizeDescriptor(primary) ?? current[0];
  if (maxSpread > 0 && descriptorDistance(anchor, safe) > maxSpread) return null;

  const limit = Math.max(1, Math.floor(max));
  if (current.length < limit) return [...current, safe];

  const next = [...current];
  next[mostRedundantIndex(next)] = safe;
  return next;
}

/** Quality a reference frame must beat the stored one by before it replaces it. */
export const FACE_PRIMARY_PROMOTE_MIN_GAIN = envNumber(
  process.env.FACE_PRIMARY_PROMOTE_MIN_GAIN,
  0.08,
  0,
  1,
);
/** Match distance above which a frame is too uncertain to become a reference. */
export const FACE_PRIMARY_PROMOTE_MAX_DISTANCE = envNumber(
  process.env.FACE_PRIMARY_PROMOTE_MAX_DISTANCE,
  0.5,
  0,
  1,
);

/**
 * Whether an incoming reference frame should replace an identity's primary one.
 *
 * An identity is enrolled from the first frame that clears the gate, which on a
 * walk-past is usually the worst of the visit. Left alone, that anchor keeps
 * pulling later matches toward a bad reference and eventually lets the same
 * person enrol twice. Replacing it requires all three:
 *  - a confident match, so a wrong match cannot rewrite someone's reference
 *    (distance 0 means "no match distance given", i.e. a fresh identity);
 *  - a clear quality gain, so ordinary jitter does not rewrite it every frame;
 *  - a quality that was actually measured.
 */
export function shouldPromotePrimary({
  storedQuality,
  incomingQuality,
  matchDistance,
  minGain = FACE_PRIMARY_PROMOTE_MIN_GAIN,
  maxDistance = FACE_PRIMARY_PROMOTE_MAX_DISTANCE,
}: {
  storedQuality: number | null | undefined;
  incomingQuality: number | null | undefined;
  matchDistance: number | null | undefined;
  minGain?: number;
  maxDistance?: number;
}) {
  const incoming = Number(incomingQuality);
  if (!Number.isFinite(incoming) || incoming <= 0) return false;

  const distance = Number(matchDistance);
  if (Number.isFinite(distance) && distance > 0 && distance > maxDistance) return false;

  // Null/absent means the identity predates quality tracking: treat it as worse
  // than anything measured, so its first good sighting upgrades it.
  const stored = Number(storedQuality);
  const safeStored = Number.isFinite(stored) && stored > 0 ? stored : 0;
  return incoming >= safeStored + minGain;
}

export function mergeDescriptor(base: number[], incoming: number[], alpha = 0.2) {
  if (!Array.isArray(base) || !Array.isArray(incoming) || base.length !== incoming.length) {
    return incoming;
  }
  const safeAlpha = Math.max(0.05, Math.min(0.95, Number(alpha) || 0.2));
  const merged = base.map((value, index) =>
    Number(((1 - safeAlpha) * Number(value) + safeAlpha * Number(incoming[index])).toFixed(6)),
  );
  if (merged.length === 512) {
    let norm = 0;
    for (const value of merged) norm += value * value;
    norm = Math.sqrt(norm);
    if (Number.isFinite(norm) && norm > 0) {
      return merged.map((value) => Number((value / norm).toFixed(6)));
    }
  }
  return merged;
}
