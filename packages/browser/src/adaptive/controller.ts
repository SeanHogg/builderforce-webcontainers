/**
 * AHEC controller — the Adaptive Heterogeneous Execution Controller.
 *
 * Owns the decide -> execute -> measure loop. For each request it:
 *   1. probes hardware facts,
 *   2. builds an explainable execution plan (cost-based, CPU-first),
 *   3. routes local vs remote (local-only unless configured otherwise),
 *   4. drives an injected executor,
 *   5. measures its own overhead against the benefit the plan provided.
 *
 * CPU-only is a first-class configuration; heterogeneous execution is enabled
 * only when the plan estimates it beats CPU-only by the configured margin.
 */

import type {
  ControllerConfig,
  ExecutionDecision,
  ExecutionOutcome,
  ExecutorLike,
  HardwareProfile,
  WorkloadProfile,
} from './types.js';
import { planExecution } from './planner.js';

/** A linear layer graph derived from the workload, for the planner to partition. */
function defaultGraph(workload: WorkloadProfile) {
  // A coarse 12-layer transformer-style graph sized to the model. The planner
  // only needs relative per-layer costs to pick a split point.
  const layers = 12;
  const attentionFraction = workload.attentionFraction ?? 0.25;
  const perLayerCpu = workload.residentBytes > 0 ? 0 : 0; // placeholder, costs set below
  void perLayerCpu;
  const base = (workload.promptTokens + workload.decodeTokens) / layers;
  return {
    layers: Array.from({ length: layers }, (_, i) => {
      const isAttention = (i % Math.max(1, Math.round(1 / Math.max(attentionFraction, 0.01)))) === 0;
      const cpuCostMs = base * (isAttention ? 1.2 : 1.0);
      return {
        id: `L${i}`,
        cpuCostMs,
        gpuCostMs: cpuCostMs * 0.3,
        inputBytes: 1024 * workload.promptTokens * 2,
      };
    }),
  };
}

/** Probe hardware facts from the environment (never throws; facts not gates). */
export function probeHardware(): HardwareProfile {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number; gpu?: unknown } })
    .navigator;
  const cores = nav?.hardwareConcurrency ?? 4;
  const deviceMemory = nav?.deviceMemory ?? 4;
  const hasGpu = typeof nav?.gpu !== 'undefined' && nav.gpu != null;
  const g = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown; WebAssembly?: unknown };
  const wasmSimd = (() => {
    try {
      return typeof g.WebAssembly !== 'undefined'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        && (g.WebAssembly as any).validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 12, 11]));
    } catch {
      return false;
    }
  })();
  return {
    cores,
    wasmSimd,
    webgpu: hasGpu,
    crossOriginIsolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof g.SharedArrayBuffer !== 'undefined',
    ramBytes: deviceMemory * 1024 * 1024 * 1024,
  };
}

export interface AdaptiveController {
  /** Decide (and optionally execute) one request. */
  execute(
    model: { id: string; paramsB: number; quantization: 'q4' | 'q5' | 'q8' | 'fp16' },
    request: { prompt: string; maxTokens?: number; signal?: AbortSignal },
  ): Promise<ExecutionOutcome>;
  /** Aggregate controller statistics (overhead vs benefit accounting). */
  stats(): { runs: number; totalOverheadMs: number; totalBenefitMs: number; lastDecision?: ExecutionDecision };
  /** The most recent explainable decision, for audit/UI. */
  lastDecision(): ExecutionDecision | undefined;
}

export function createAdaptiveController(
  executor: ExecutorLike,
  config: ControllerConfig = {},
): AdaptiveController {
  // Probe once; the controller treats hardware as stable within a session.
  const hardware = config.hardwareOverride ?? probeHardware();
  let last: ExecutionDecision | undefined;
  let runs = 0;
  let totalOverheadMs = 0;
  let totalBenefitMs = 0;

  return {
    async execute(model, request) {
      const workload: WorkloadProfile = {
        paramsB: model.paramsB,
        quantization: model.quantization,
        promptTokens: estimateTokens(request.prompt),
        decodeTokens: request.maxTokens ?? 128,
        residentBytes: estimateResidentBytes(model),
      };

      const planStart = nowMs();
      const plan = planExecution({ workload, hardware, graph: defaultGraph(workload), config });
      const overheadMs = nowMs() - planStart;

      const route = config.allowRemote === true && hardware.webgpu === false && workload.paramsB > 13
        ? ('remote' as const)
        : ('local' as const);
      const decision: ExecutionDecision = { plan, route, hardware, workload };
      if (route === 'remote') {
        decision.plan.reasoning.push('remote route: model too large for local memory and remote allowed');
      }
      last = decision;
      config.onDecision?.(decision);

      const execStart = nowMs();
      const stream = executor.generate(
        { id: model.id, paramsB: model.paramsB, quantization: model.quantization },
        { prompt: request.prompt, maxTokens: request.maxTokens ?? 128, signal: request.signal },
      );
      let tokens = 0;
      for await (const event of stream) {
        if (event.token) tokens += 1;
      }
      const measuredCostMs = nowMs() - execStart;

      const benefitMs = decision.plan.estimatedCostMs - measuredCostMs;
      runs += 1;
      totalOverheadMs += overheadMs;
      totalBenefitMs += benefitMs;

      return { decision, measuredCostMs, overheadMs, benefitMs, tokens };
    },
    stats() {
      return { runs, totalOverheadMs, totalBenefitMs, lastDecision: last };
    },
    lastDecision() {
      return last;
    },
  };
}

/** Override the probed hardware profile (test hook, see ControllerConfig). */
function estimateTokens(text: string): number {
  // ~4 chars per token is a reasonable English/code average.
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateResidentBytes(model: { paramsB: number; quantization: string }): number {
  const bytesPerParam = model.quantization === 'q4' ? 0.5
    : model.quantization === 'q5' ? 0.625
    : model.quantization === 'q8' ? 1.0
    : 2.0;
  // Weights + ~20% KV/activation headroom.
  return model.paramsB * 1e9 * bytesPerParam * 1.2;
}

function nowMs(): number {
  const g = globalThis as { performance?: { now(): number } };
  return g.performance?.now?.() ?? Date.now();
}
