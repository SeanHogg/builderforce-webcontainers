import { describe, expect, it } from 'vitest';
import { createAdaptiveController } from '../src/adaptive/controller.js';
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

const GRAPH = {
  layers: Array.from({ length: 12 }, (_, i) => ({
    id: `L${i}`,
    cpuCostMs: 10,
    gpuCostMs: 3,
    inputBytes: 2048,
  })),
};

function mockExecutor(delayMs = 1) {
  return {
    load: async () => ({}),
    generate: (model: unknown, options: { maxTokens?: number }) => {
      const max = options.maxTokens ?? 3;
      const stream = (async function* () {
        for (let i = 0; i < max; i++) {
          await new Promise((r) => setTimeout(r, delayMs));
          yield { token: `t${i}` };
        }
      })();
      (stream as { stats?: () => Promise<{ ttftMs: number; tokensPerSecond: number }> }).stats = async () => ({
        ttftMs: delayMs,
        tokensPerSecond: 1000 / Math.max(1, delayMs),
      });
      void model;
      return stream;
    },
  };
}

describe('planExecution', () => {
  it('selects cpu-only when no GPU is available', () => {
    const plan = planExecution({ workload: WORKLOAD, hardware: CPU_ONLY_HW, graph: GRAPH, config: {} });
    expect(plan.strategy).toBe('cpu-only');
    expect(plan.gpuLayerIds).toHaveLength(0);
    expect(plan.cpuLayerIds).toHaveLength(GRAPH.layers.length);
    expect(plan.reasoning.join(' ')).toMatch(/cpu-only/);
  });

  it('forces cpu-only when config.cpuOnly is set, even with a GPU', () => {
    const plan = planExecution({ workload: WORKLOAD, hardware: GPU_HW, graph: GRAPH, config: { cpuOnly: true } });
    expect(plan.strategy).toBe('cpu-only');
    expect(plan.reasoning.join(' ')).toMatch(/cpu-only forced by config/);
  });

  it('produces an explainable reasoning trail on every plan', () => {
    const plan = planExecution({ workload: WORKLOAD, hardware: CPU_ONLY_HW, graph: GRAPH, config: {} });
    expect(plan.reasoning.length).toBeGreaterThan(0);
    for (const line of plan.reasoning) expect(typeof line).toBe('string');
  });
});

describe('createAdaptiveController', () => {
  it('executes locally and measures controller overhead', async () => {
    const controller = createAdaptiveController(mockExecutor(1), { hardwareOverride: CPU_ONLY_HW });
    const outcome = await controller.execute(
      { id: 'm1', paramsB: 1.1, quantization: 'q4' },
      { prompt: 'hello world', maxTokens: 4 },
    );
    expect(outcome.decision.route).toBe('local');
    expect(outcome.decision.plan.strategy).toBe('cpu-only');
    expect(outcome.tokens).toBe(4);
    expect(outcome.overheadMs).toBeGreaterThanOrEqual(0);
    expect(controller.stats().runs).toBe(1);
  });

  it('records explainable decisions through onDecision', async () => {
    const decisions: string[] = [];
    const controller = createAdaptiveController(mockExecutor(1), {
      hardwareOverride: CPU_ONLY_HW,
      onDecision: (d) => decisions.push(d.plan.strategy),
    });
    await controller.execute({ id: 'm1', paramsB: 1.1, quantization: 'q4' }, { prompt: 'hi', maxTokens: 2 });
    expect(decisions).toEqual(['cpu-only']);
    expect(controller.lastDecision()?.plan.reasoning.length).toBeGreaterThan(0);
  });

  it('accounts overhead separately from benefit', async () => {
    const controller = createAdaptiveController(mockExecutor(1), { hardwareOverride: CPU_ONLY_HW });
    await controller.execute({ id: 'm1', paramsB: 1.1, quantization: 'q4' }, { prompt: 'x', maxTokens: 1 });
    const stats = controller.stats();
    expect(stats.totalOverheadMs).toBeGreaterThanOrEqual(0);
    // benefit is planned - measured; with a fast mock it can be positive or
    // negative, but it must be a finite number.
    expect(Number.isFinite(stats.totalBenefitMs)).toBe(true);
  });
});
