/**
 * Phase 5 — quantization-aware execution.
 *
 * Picks the runtime format from `ModelRef.quantization` (`q4`|`q5`|`q8`|`fp16`)
 * and avoids converting unless `preconvertQuant` is opted in. Conversion is
 * never implicit: the native format is used unless a flag + target justify it.
 */

import type { KvBackendKind, KvQuantization, QuantPlan } from './types.js';

const BYTES: Record<KvQuantization, number> = {
  q4: 0.5,
  q5: 0.625,
  q8: 1,
  fp16: 2,
};

/** Relative quality vs fp16, used by the default scorer. */
const QUALITY: Record<KvQuantization, number> = {
  fp16: 1,
  q8: 0.99,
  q5: 0.97,
  q4: 0.94,
};

export function bytesPerParam(q: KvQuantization): number {
  return BYTES[q];
}

export function nativeQuality(q: KvQuantization): number {
  return QUALITY[q];
}

/**
 * Decide the runtime quantization. Conversion is skipped unless
 * `preconvert` is true AND the target is a strictly smaller format
 * (justified by a bandwidth saving).
 */
export function planQuantization(input: {
  native: KvQuantization;
  backend: KvBackendKind;
  preconvert: boolean;
  preconvertTo?: KvQuantization;
}): QuantPlan {
  const native = input.native;
  const target = input.preconvertTo ?? 'q4';
  const justified =
    input.preconvert && BYTES[target] < BYTES[native] && backendSupports(input.backend, target);
  if (!justified) {
    return {
      native,
      runtime: native,
      converted: false,
      conversionCost: 0,
      bytesPerParam: BYTES[native],
    };
  }
  return {
    native,
    runtime: target,
    converted: true,
    conversionCost: BYTES[native] - BYTES[target],
    bytesPerParam: BYTES[target],
  };
}

export function backendSupports(backend: KvBackendKind, q: KvQuantization): boolean {
  if (backend === 'webllm') return q === 'fp16' || q === 'q4';
  if (backend === 'wllama') return q !== 'fp16';
  return true;
}

export function bandwidthBytes(params: number, plan: QuantPlan, tokens: number, kvDim: number): number {
  const weightBytes = params * plan.bytesPerParam;
  const kvBytes = tokens * kvDim * plan.bytesPerParam;
  return weightBytes + kvBytes;
}

export const DEFAULT_QUALITY_TOLERANCE = 0.08;

export function defaultQualityScorer(input: {
  output: string;
  baselineOutput: string;
  quantization: KvQuantization;
  baselineQuantization: KvQuantization;
}): number {
  const q = nativeQuality(input.quantization) / nativeQuality(input.baselineQuantization);
  if (!input.baselineOutput) return q;
  const a = input.output;
  const b = input.baselineOutput;
  const n = Math.max(a.length, b.length, 1);
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a.charCodeAt(i) === b.charCodeAt(i)) same++;
  }
  const overlap = same / n;
  return Math.min(1, q * 0.5 + overlap * 0.5);
}
