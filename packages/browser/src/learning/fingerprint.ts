/**
 * Phase 7 — workload fingerprinting.
 *
 * Buckets a workload into a stable signature (the learner's table key) and
 * maps a Phase 2 `ExecutionOutcome` into an observation. Type-only coupling to
 * the adaptive controller: nothing here imports or calls it.
 */

import type { ExecutionOutcome } from '../adaptive/types.js';
import type { OutcomeObservation, WorkloadFingerprintInput } from './types.js';

function bucket(value: number, edges: readonly number[]): string {
  let lower = 0;
  for (const edge of edges) {
    if (value < edge) return `${lower}-${edge}`;
    lower = edge;
  }
  const last = edges[edges.length - 1] ?? 0;
  return `${last}+`;
}

/** Stable signature for a workload. Same buckets always produce the same key. */
export function fingerprintWorkload(input: WorkloadFingerprintInput): string {
  const params = bucket(input.paramsB ?? 0, [1, 3, 8]);
  const prompt = bucket(input.promptTokens ?? 0, [128, 512, 2048]);
  const decode = bucket(input.decodeTokens ?? 0, [64, 256, 1024]);
  const quant = input.quantization && input.quantization.length > 0 ? input.quantization : 'unknown';
  return `p${params}|q:${quant}|prompt:${prompt}|decode:${decode}`;
}

/**
 * Map a Phase 2 `ExecutionOutcome` into an observation. Type-only coupling:
 * this does not import the controller, and it does not apply anything.
 */
export function observationFromExecution(outcome: ExecutionOutcome, correct = true): OutcomeObservation {
  const workload = outcome.decision.workload;
  return {
    signature: fingerprintWorkload({
      paramsB: workload.paramsB,
      quantization: workload.quantization,
      promptTokens: workload.promptTokens,
      decodeTokens: workload.decodeTokens,
    }),
    strategy: outcome.decision.plan.strategy,
    costMs: outcome.measuredCostMs,
    overheadMs: outcome.overheadMs,
    benefitMs: outcome.benefitMs,
    correct,
  };
}
