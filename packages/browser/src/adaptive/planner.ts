/**
 * AHEC planner — cost-based execution planning over the layer graph.
 *
 * HEFT-lite: for the linear transformer-style dependency chain (L0 -> L1 -> ...)
 * the partition problem reduces to choosing a split point, which dynamic
 * programming solves exactly in O(n). We also evaluate the all-CPU and all-GPU
 * extremes. A heterogeneous plan is only returned when it beats the best
 * homogeneous plan by the configured margin — heterogeneity is never assumed.
 */

import type { ControllerConfig, ExecutionGraph, ExecutionPlan, HardwareProfile, WorkloadProfile } from './types.js';
import { estimateCpuCost, estimateGpuCost, estimateSplitCost } from './costModel.js';

export interface PlanRequest {
  workload: WorkloadProfile;
  hardware: HardwareProfile;
  graph: ExecutionGraph;
  config: ControllerConfig;
}

/**
 * Plan execution for one request. Pure given its inputs — the same request
 * always yields the same plan, which keeps decisions explainable and testable.
 */
export function planExecution(req: PlanRequest): ExecutionPlan {
  const { workload, hardware, graph, config } = req;
  const reasoning: string[] = [];
  const margin = config.heterogeneityMargin ?? 0.05;
  const syncPenalty = config.transferSyncPenaltyMs ?? 4;

  const cpuOnlyForced = config.cpuOnly === true;
  if (cpuOnlyForced) reasoning.push('cpu-only forced by config');

  const cpu = estimateCpuCost(workload, hardware);
  reasoning.push(`cpu estimate ${cpu.totalMs.toFixed(1)}ms`);

  // CPU-only candidate.
  let best: ExecutionPlan = {
    strategy: 'cpu-only',
    backend: pickBackend(hardware, 'cpu-only'),
    reasoning: [...reasoning, 'cpu-only selected'],
    estimatedCostMs: cpu.totalMs,
    gpuLayerIds: [],
    cpuLayerIds: graph.layers.map((l) => l.id),
  };
  let bestCost = cpu.totalMs;

  const gpuUsable = !cpuOnlyForced && hardware.webgpu;
  if (!hardware.webgpu) reasoning.push('webgpu unavailable');

  if (gpuUsable) {
    const gpu = estimateGpuCost(workload, hardware);
    if (gpu) {
      reasoning.push(`gpu estimate ${gpu.totalMs.toFixed(1)}ms`);
      // GPU-only candidate.
      if (gpu.totalMs < bestCost * (1 - margin)) {
        best = {
          strategy: 'gpu-only',
          backend: pickBackend(hardware, 'gpu-only'),
          reasoning: [...reasoning, `gpu-only beats cpu by ${(bestCost - gpu.totalMs).toFixed(1)}ms`],
          estimatedCostMs: gpu.totalMs,
          gpuLayerIds: graph.layers.map((l) => l.id),
          cpuLayerIds: [],
        };
        bestCost = gpu.totalMs;
      }

      // Split candidates: prefix-on-CPU/suffix-on-GPU and the reverse, plus a
      // mid split. DP over all split points for exactness on the linear chain.
      const n = graph.layers.length;
      if (n > 0) {
        // Cumulative per-layer cost lets us score any split point in O(1).
        let cpuPrefix = 0;
        const cpuCumulative: number[] = [];
        let gpuPrefix = 0;
        const gpuCumulative: number[] = [];
        for (const layer of graph.layers) {
          cpuPrefix += layer.cpuCostMs;
          gpuPrefix += Number.isFinite(layer.gpuCostMs) ? layer.gpuCostMs : layer.cpuCostMs * 4;
          cpuCumulative.push(cpuPrefix);
          gpuCumulative.push(gpuPrefix);
        }
        const totalCpu = cpuPrefix;
        const totalGpu = gpuPrefix;

        for (let split = 0; split <= n; split++) {
          const cpuPart = cpuCumulative[split - 1] ?? 0;
          const gpuPart = totalGpu - (gpuCumulative[split - 1] ?? 0);
          const gpuFraction = totalGpu > 0 ? gpuPart / totalGpu : 0;
          const est = estimateSplitCost(workload, hardware, gpuFraction, syncPenalty);
          if (!est) continue;
          // Scale the analytic split estimate to the per-layer graph costs so the
          // plan honors the actual dependency structure, not just the analytic model.
          const graphCompute = cpuPart + gpuPart;
          const analyticCompute = est.computeMs || 1;
          const scaled = (est.totalMs - est.computeMs) + graphCompute * (est.computeMs / analyticCompute);
          if (scaled < bestCost * (1 - margin)) {
            const gpuIds = graph.layers.slice(split).map((l) => l.id);
            const cpuIds = graph.layers.slice(0, split).map((l) => l.id);
            best = {
              strategy: split === 0 ? 'gpu-only' : split === n ? 'cpu-only' : 'layer-split',
              backend: pickBackend(hardware, 'layer-split'),
              reasoning: [
                ...reasoning,
                `layer-split at ${split}/${n} (gpu layers ${gpuIds.length}) saves est. ${(bestCost - scaled).toFixed(1)}ms after ${(est.transferMs + est.syncMs).toFixed(1)}ms transfer+sync`,
              ],
              estimatedCostMs: scaled,
              gpuLayerIds: gpuIds,
              cpuLayerIds: cpuIds,
            };
            bestCost = scaled;
          }
        }
      }
    }
  }

  return best;
}

function pickBackend(hw: HardwareProfile, strategy: ExecutionPlan['strategy']): ExecutionPlan['backend'] {
  // WebGPU-present strategies prefer the WebLLM adapter; CPU paths prefer ONNX
  // (Wllama when cross-origin isolation enables threaded decode).
  if (strategy === 'gpu-only') return 'webllm';
  if (hw.crossOriginIsolated && hw.sharedArrayBuffer) return 'wllama';
  return 'onnx';
}
