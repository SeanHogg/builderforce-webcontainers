/**
 * AHEC cost model — estimates execution cost from workload + hardware facts.
 *
 * Pure and deterministic: the same inputs always produce the same estimate, so
 * planning decisions are reproducible and explainable. Estimates are coarse by
 * design (they rank strategies, they do not predict wall-clock to the ms).
 */

import type { HardwareProfile, WorkloadProfile } from './types.js';

/** Cost estimate breakdown for one candidate execution. */
export interface CostEstimate {
  /** Compute time in ms. */
  computeMs: number;
  /** Data-transfer time in ms (activations/weights crossing the device boundary). */
  transferMs: number;
  /** Fixed per-sync-point overhead in ms. */
  syncMs: number;
  /** Memory-allocation penalty in ms (cold buffers). */
  allocMs: number;
  /** Cache-miss penalty in ms (weights/activations not resident). */
  cacheMissMs: number;
  /** Total wall-clock estimate in ms. */
  totalMs: number;
}

/** Bytes per activation element (fp16 KV / activations in the 1B–4B target range). */
const BYTES_PER_ELEM = 2;

/** Rough per-param per-token FLOPs multiplier for decode (2 for forward pass). */
const FLOPS_PER_PARAM_PER_TOKEN = 2;

/** Assume ~1 GFLOP/ms effective on a single scalar wasm core; SIMD ~4x; multi-core adds a sub-linear gain. */
function cpuGflopsPerMs(hw: HardwareProfile): number {
  let g = 1.0;
  if (hw.wasmSimd) g *= 4;
  // Sub-linear multi-core gain: cores help prefill (parallel) more than decode.
  g *= 1 + Math.min(hw.cores, 8) * 0.25;
  return g;
}

/** Rough effective GPU throughput multiplier over a single scalar CPU core. */
function gpuGflopsPerMs(_hw: HardwareProfile): number {
  // Deliberately conservative: integrated/mobile GPUs are far weaker than discrete.
  return 40;
}

/** Working estimate of effective active parameters from the profile. */
function effectiveParams(workload: WorkloadProfile): number {
  const dense = workload.paramsB * 1e9;
  return dense * (workload.activeFraction ?? 1);
}

/**
 * Estimate the cost of running `workload` entirely on CPU.
 */
export function estimateCpuCost(workload: WorkloadProfile, hw: HardwareProfile): CostEstimate {
  const params = effectiveParams(workload);
  const flops = params * FLOPS_PER_PARAM_PER_TOKEN * (workload.promptTokens + workload.decodeTokens);
  const computeMs = flops / (cpuGflopsPerMs(hw) * 1e9) * 1000;

  // KV cache + weight residency: if the model does not fit comfortably in RAM,
  // add a cache-miss penalty proportional to the shortfall.
  const ramBudget = hw.ramBytes * 0.5;
  const cacheMissMs = workload.residentBytes > ramBudget
    ? ((workload.residentBytes - ramBudget) / 1e6) * 2
    : 0;

  const allocMs = Math.min(workload.residentBytes / 1e7, 200); // cold buffer setup, capped
  return {
    computeMs,
    transferMs: 0,
    syncMs: 0,
    allocMs,
    cacheMissMs,
    totalMs: computeMs + allocMs + cacheMissMs,
  };
}

/**
 * Estimate the cost of running `workload` entirely on GPU (when available).
 */
export function estimateGpuCost(workload: WorkloadProfile, hw: HardwareProfile): CostEstimate | null {
  if (!hw.webgpu) return null;
  const params = effectiveParams(workload);
  const flops = params * FLOPS_PER_PARAM_PER_TOKEN * (workload.promptTokens + workload.decodeTokens);
  const computeMs = flops / (gpuGflopsPerMs(hw) * 1e9) * 1000;
  // Upload weights once (residentBytes across the bus at ~5 GB/s effective).
  const transferMs = workload.residentBytes / 5e9 * 1000;
  const allocMs = Math.min(workload.residentBytes / 1e7, 200);
  return {
    computeMs,
    transferMs,
    syncMs: 0,
    allocMs,
    cacheMissMs: 0,
    totalMs: computeMs + transferMs + allocMs,
  };
}

/**
 * Estimate a split (heterogeneous) plan: `gpuFraction` of the compute runs on
 * GPU, the rest on CPU, with one transfer + sync at the device boundary.
 */
export function estimateSplitCost(
  workload: WorkloadProfile,
  hw: HardwareProfile,
  gpuFraction: number,
  transferSyncPenaltyMs: number,
): CostEstimate | null {
  const gpu = estimateGpuCost(workload, hw);
  if (!gpu) return null;
  const cpu = estimateCpuCost(workload, hw);
  const gpuPart = gpu.computeMs * gpuFraction;
  const cpuPart = cpu.computeMs * (1 - gpuFraction);
  // Layers run in dependency order; without device overlap the compute is serial.
  const computeMs = gpuPart + cpuPart;
  // Only the boundary activations cross the bus, not the full weights.
  const boundaryBytes = workload.residentBytes * 0.02 + BYTES_PER_ELEM * workload.promptTokens * 1024;
  const transferMs = boundaryBytes / 5e9 * 1000;
  const syncMs = transferSyncPenaltyMs;
  const allocMs = Math.max(cpu.allocMs, gpu.allocMs);
  return {
    computeMs,
    transferMs,
    syncMs,
    allocMs,
    cacheMissMs: cpu.cacheMissMs * (1 - gpuFraction),
    totalMs: computeMs + transferMs + syncMs + allocMs,
  };
}
