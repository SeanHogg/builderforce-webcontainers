/**
 * Phase 3 — reuse-probability and reload-cost estimation.
 *
 * Pure functions. The manager calls these when the caller does not supply an
 * estimate, and cost-aware eviction weighs `reuseProbability * reloadCostMs`
 * against footprint. Nothing here touches inference or decides when to run.
 */

import type { ResidencyTier } from './types.js';

/** Bytes per parameter by quantization bucket. Mirrors the Phase 2 controller. */
export function bytesPerParam(quantization: string): number {
  switch (quantization) {
    case 'q4':
      return 0.5;
    case 'q5':
      return 0.625;
    case 'q8':
      return 1;
    case 'fp16':
      return 2;
    default:
      return 0.5;
  }
}

/**
 * Estimated weight footprint for a model, in bytes.
 * `paramsB` is billions of parameters. Headroom (default 20%) covers KV and
 * activations so a residency admission does not under-count.
 */
export function estimateWeightBytes(paramsB: number, quantization: string, headroom = 1.2): number {
  const params = Number.isFinite(paramsB) && paramsB > 0 ? paramsB : 0;
  return Math.round(params * 1e9 * bytesPerParam(quantization) * Math.max(1, headroom));
}

export interface ReloadCostInput {
  /** Footprint in bytes. */
  bytes: number;
  /** Where the bytes would be reloaded from. */
  from: ResidencyTier | 'network';
  /** Optional measured throughput in bytes/ms. Overrides the tier default. */
  bytesPerMs?: number;
}

/** Default reload throughput by source, bytes per ms. Conservative CPU-only figures. */
const DEFAULT_THROUGHPUT: Record<ReloadCostInput['from'], number> = {
  // A RAM hit is not a reload; callers should not ask. Kept non-zero for safety.
  ram: 1_000_000,
  // VRAM copy over the optional GPU path. Hint only.
  vram: 200_000,
  // IndexedDB read on a typical laptop-class disk.
  storage: 50_000,
  // Re-download. Slow, and the reason cost-aware keeps hot weights.
  network: 2_000,
};

/**
 * Estimated milliseconds to reload `bytes` from `from`.
 * Always >= 0. A zero-byte entry reloads in 0.
 */
export function estimateReloadCostMs(input: ReloadCostInput): number {
  const bytes = Number.isFinite(input.bytes) && input.bytes > 0 ? input.bytes : 0;
  const throughput = input.bytesPerMs && input.bytesPerMs > 0 ? input.bytesPerMs : DEFAULT_THROUGHPUT[input.from];
  return bytes / throughput;
}

export interface ReuseObservation {
  /** Hits recorded for this id. */
  hits: number;
  /** Misses (or admissions that were not hits) recorded for this id. */
  misses: number;
  /** Ms since the last touch. Undefined if never touched. */
  idleMs?: number;
  /** Half-life of recency, ms. Default 60s. */
  halfLifeMs?: number;
}

/**
 * Estimated probability this id is reused before the next pressure event.
 * Combines a Laplace-smoothed hit frequency with an exponential recency decay
 * so a hot-but-idle entry cools off. Result is in [0, 1].
 */
export function estimateReuseProbability(observation: ReuseObservation): number {
  const hits = Math.max(0, observation.hits);
  const misses = Math.max(0, observation.misses);
  // Laplace smoothing: an unseen id is 0.5, not 0 or 1.
  const frequency = (hits + 1) / (hits + misses + 2);
  const halfLife = observation.halfLifeMs && observation.halfLifeMs > 0 ? observation.halfLifeMs : 60_000;
  const idle = observation.idleMs && observation.idleMs > 0 ? observation.idleMs : 0;
  const recency = Math.pow(0.5, idle / halfLife);
  return clamp01(frequency * recency);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
