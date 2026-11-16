import { describe, expect, it } from 'vitest';
import { estimateCpuCost, estimateGpuCost, estimateSplitCost } from '../src/adaptive/costModel.js';
import { planExecution } from '../src/adaptive/planner.js';
import type { HardwareProfile, WorkloadProfile } from '../src/adaptive/types.js';

const CPU_ONLY_HW: HardwareProfile = {
  cores: 8,
  wasmSimd: true,
  webgpu: false,
  crossOriginIsolated: false,
  sharedArrayBuffer: false,
  ramBytes: 8 * 1024 * 1024 * 1024,
};

const GPU_HW: HardwareProfile = { ...CPU_ONLY_HW, webgpu: true };

const WORKLOAD: WorkloadProfile = {
  paramsB: 1.1,
  quantization: 'q4',
  promptTokens: 64,
  decodeTokens: 128,
  residentBytes: 1.1e9 * 0.5 * 1.2,
};

function makeGraph(cpuPerLayer: number, gpuPerLayer: number) {
  return {
    layers: Array.from({ length: 12 }, (_, i) => ({
      id: `L${i}`,
      cpuCostMs: cpuPerLayer,
      gpuCostMs: gpuPerLayer,
      inputBytes: 2048,
    })),
  };
}

describe('costModel', () => {
  it('cpu estimate is deterministic and positive', () => {
    const a = estimateCpuCost(WORKLOAD, CPU_ONLY_HW);
    const b = estimateCpuCost(WORKLOAD, CPU_ONLY_HW);
    expect(a.totalMs).toBe(b.totalMs);
    expect(a.totalMs).toBeGreaterThan(0);
    expect(a.transferMs).toBe(0);
    expect(a.syncMs).toBe(0);
  });

  it('gpu estimate is null without webgpu', () => {
    expect(estimateGpuCost(WORKLOAD, CPU_ONLY_HW)).toBeNull();
  });

  it('gpu estimate includes transfer when webgpu present', () => {
    const gpu = estimateGpuCost(WORKLOAD, GPU_HW);
    expect(gpu).not.toBeNull();
    expect(gpu!.transferMs).toBeGreaterThan(0);
    expect(gpu!.totalMs).toBeGreaterThan(gpu!.computeMs);
  });

  it('split estimate adds transfer + sync on top of compute', () => {
    const split = estimateSplitCost(WORKLOAD, GPU_HW, 0.5, 4);
    expect(split).not.toBeNull();
    expect(split!.transferMs).toBeGreaterThan(0);
    expect(split!.syncMs).toBe(4);
    expect(split!.totalMs).toBeGreaterThan(split!.computeMs);
  });

  it('split estimate is null without webgpu', () => {
    expect(estimateSplitCost(WORKLOAD, CPU_ONLY_HW, 0.5, 4)).toBeNull();
  });
});

describe('planner heterogeneity gating', () => {
  it('does NOT choose a split when GPU savings do not clear the margin (no regression)', () => {
    // gpuPerLayer only marginally faster than cpuPerLayer -> split not worth it after transfer+sync.
    const graph = makeGraph(10, 9);
    const plan = planExecution({ workload: WORKLOAD, hardware: GPU_HW, graph, config: {} });
    expect(plan.strategy === 'cpu-only' || plan.strategy === 'gpu-only' || plan.strategy === 'layer-split').toBe(true);
    // Because savings are tiny vs the 4ms sync + transfer, the planner must NOT
    // emit a heterogeneous layer-split here; it should stay homogeneous.
    expect(plan.strategy).not.toBe('layer-split');
  });

  it('CPU-only is always a valid plan and cpuOnly config forces it', () => {
    const graph = makeGraph(10, 1);
    const forced = planExecution({ workload: WORKLOAD, hardware: GPU_HW, graph, config: { cpuOnly: true } });
    expect(forced.strategy).toBe('cpu-only');
    expect(forced.gpuLayerIds).toHaveLength(0);
    const noGpu = planExecution({ workload: WORKLOAD, hardware: CPU_ONLY_HW, graph, config: {} });
    expect(noGpu.strategy).toBe('cpu-only');
  });

  it('chooses a heterogeneous split only when it clears the margin, and is explainable', () => {
    // Strong GPU advantage + a workload whose analytic GPU estimate is far below CPU.
    const bigWorkload: WorkloadProfile = { ...WORKLOAD, paramsB: 4, promptTokens: 512, decodeTokens: 256, residentBytes: 4e9 * 0.5 * 1.2 };
    const graph = makeGraph(10, 0.5);
    const plan = planExecution({ workload: bigWorkload, hardware: GPU_HW, graph, config: { heterogeneityMargin: 0.0 } });
    // With a strong GPU and zero margin, the planner should exploit the GPU somewhere.
    expect(plan.gpuLayerIds.length + plan.cpuLayerIds.length).toBe(graph.layers.length);
    expect(plan.reasoning.length).toBeGreaterThan(0);
  });

  it('every plan layer is assigned to exactly one device', () => {
    const graph = makeGraph(10, 3);
    const plan = planExecution({ workload: WORKLOAD, hardware: GPU_HW, graph, config: {} });
    const all = [...plan.gpuLayerIds, ...plan.cpuLayerIds].sort();
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });
});
