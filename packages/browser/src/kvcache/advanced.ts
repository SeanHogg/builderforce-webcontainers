/**
 * Phase 5 — optional advanced inference, gated by explicit opt-in flags
 * AND capability checks. Architecture-specific optimizations are never
 * applied to incompatible models; the plain path is the default.
 */

import type { AdvancedCapabilities, OptimizationFlag } from './types.js';

const DECODER_FAMILIES = new Set(['decoder-transformer', 'llama', 'gpt', 'mistral', 'qwen']);

export function isEnabled(
  flags: Partial<Record<OptimizationFlag, boolean>> | undefined,
  flag: OptimizationFlag,
): boolean {
  return flags?.[flag] === true;
}

export function canSpeculative(caps: AdvancedCapabilities): boolean {
  return (
    caps.speculativeDecoding &&
    caps.hasDraftModel &&
    DECODER_FAMILIES.has(caps.architecture)
  );
}

export function canContinuousBatch(caps: AdvancedCapabilities): boolean {
  return caps.continuousBatching && DECODER_FAMILIES.has(caps.architecture);
}

export function canActivationSparsity(caps: AdvancedCapabilities): boolean {
  return caps.activationSparsity && caps.sparsityFraction > 0 && DECODER_FAMILIES.has(caps.architecture);
}

/**
 * Simulated decode cost in abstract time units.
 * Speculative: draft + verify of a block; accepted tokens skip full compute.
 * Sparsity: compute scaled by (1 - sparsityFraction).
 * Continuous batching is applied at the batch level (see runtime).
 */
export function decodeCost(input: {
  tokens: number;
  computePerToken: number;
  speculative: boolean;
  sparsity: boolean;
  draftLen: number;
  draftAccuracy: number;
  draftPerToken: number;
  verifyPerToken: number;
  sparsityFraction: number;
}): { cost: number; applied: OptimizationFlag[] } {
  const applied: OptimizationFlag[] = [];
  let per = input.computePerToken;
  if (input.sparsity) {
    per *= Math.max(0, 1 - input.sparsityFraction);
    applied.push('activationSparsity');
  }
  if (!input.speculative || input.tokens <= 0) {
    return { cost: input.tokens * per, applied };
  }
  applied.push('speculativeDecoding');
  const block = Math.max(1, input.draftLen);
  const blocks = Math.ceil(input.tokens / block);
  const accepted = Math.min(1, Math.max(0, input.draftAccuracy));
  // Each block: draft `block` tokens cheaply, then verify. Accepted tokens
  // pay only draft+verify; rejected tokens fall back to full compute.
  const draftCost = blocks * block * input.draftPerToken;
  const verifyCost = blocks * input.verifyPerToken;
  const rejectCost = (1 - accepted) * input.tokens * per;
  const acceptCost = accepted * input.tokens * input.verifyPerToken;
  return { cost: draftCost + verifyCost + rejectCost + acceptCost, applied };
}

export function batchCost(input: {
  tokenCounts: number[];
  computePerToken: number;
  continuous: boolean;
}): { cost: number; applied: OptimizationFlag[] } {
  const sum = input.tokenCounts.reduce((a, b) => a + b, 0);
  if (!input.continuous || input.tokenCounts.length <= 1) {
    return { cost: sum * input.computePerToken, applied: [] };
  }
  // Continuous batching: shared prefill/decode step, cost ≈ max sequence
  // rather than the sum. Demonstrably cheaper than sequential.
  const max = input.tokenCounts.reduce((a, b) => Math.max(a, b), 0);
  return { cost: max * input.computePerToken, applied: ['continuousBatching'] };
}
