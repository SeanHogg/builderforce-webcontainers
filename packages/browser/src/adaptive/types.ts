/**
 * Adaptive Heterogeneous Execution Controller (AHEC) — types.
 *
 * The controller decides WHERE/HOW to execute an inference workload and WHY.
 * It is deliberately decoupled from the execution engine in `src/inference/`
 * (which only knows HOW to run): the controller routes to an injected executor
 * and picks a backend + strategy from measured hardware capabilities.
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 */

/** Hardware facts probed from the environment. Facts, not gates. */
export interface HardwareProfile {
  /** Logical CPU cores available to workers. */
  cores: number;
  /** WebAssembly SIMD is available (v128 probe). */
  wasmSimd: boolean;
  /** WebGPU adapter is present and usable. */
  webgpu: boolean;
  /** Page is cross-origin isolated. */
  crossOriginIsolated: boolean;
  /** SharedArrayBuffer is available. */
  sharedArrayBuffer: boolean;
  /** Usable RAM hint in bytes (navigator.deviceMemory * ~1GiB when present). */
  ramBytes: number;
}

/**
 * Characterization of one inference request, used for planning.
 * All fields are hints the planner reasons over; none are required to be exact.
 */
export interface WorkloadProfile {
  /** Model size in billions of parameters. */
  paramsB: number;
  /** Quantization bucket, matching `ModelRef.quantization`. */
  quantization: 'q4' | 'q5' | 'q8' | 'fp16';
  /** Expected prompt (prefill) token count. */
  promptTokens: number;
  /** Expected decode (generation) token count. */
  decodeTokens: number;
  /** Approximate resident bytes the model needs (weights + KV headroom). */
  residentBytes: number;
  /** Fraction of layers that are attention (rest treated as FFN). */
  attentionFraction?: number;
  /** Sparsity / MoE: fraction of parameters active per token (1 = dense). */
  activeFraction?: number;
}

/** One node in the layer-dependency graph the planner partitions. */
export interface LayerNode {
  id: string;
  /** Estimated cost to run this layer on CPU, in ms. */
  cpuCostMs: number;
  /** Estimated cost on GPU, in ms (Infinity if unsupported). */
  gpuCostMs: number;
  /** Bytes of activations this layer consumes from its predecessor. */
  inputBytes: number;
}

/** A linear-dependency layer graph (transformer-style: L0 -> L1 -> ... -> Ln). */
export interface ExecutionGraph {
  layers: LayerNode[];
}

/** Where a plan runs. */
export type ExecutionStrategy =
  | 'cpu-only'
  | 'gpu-only'
  | 'cpu-prefill-gpu-decode'
  | 'gpu-prefill-cpu-decode'
  | 'layer-split';

/** A chosen execution strategy with its justification. */
export interface ExecutionPlan {
  strategy: ExecutionStrategy;
  /** Which backend kind the executor should use. */
  backend: 'onnx' | 'wllama' | 'webllm' | 'mock';
  /** Human-readable, auditable reasoning trail for this decision. */
  reasoning: string[];
  /** Estimated wall-clock cost in ms (including transfer + sync). */
  estimatedCostMs: number;
  /** Layers assigned to GPU (empty for cpu-only). */
  gpuLayerIds: string[];
  /** Layers assigned to CPU. */
  cpuLayerIds: string[];
}

/** The decision the controller makes for one request. */
export interface ExecutionDecision {
  plan: ExecutionPlan;
  /** 'local' | 'remote' — remote is only chosen when explicitly configured. */
  route: 'local' | 'remote';
  /** Probed hardware snapshot the decision was made against. */
  hardware: HardwareProfile;
  /** Workload snapshot the decision was made against. */
  workload: WorkloadProfile;
}

/** Result of running one request through the controller. */
export interface ExecutionOutcome {
  decision: ExecutionDecision;
  /** Wall-clock ms actually observed for the executor call. */
  measuredCostMs: number;
  /** ms the controller spent planning (its own overhead). */
  overheadMs: number;
  /** planned - measured; positive means the plan beat the estimate. */
  benefitMs: number;
  /** Tokens produced (when the executor reports them). */
  tokens?: number;
}

/** Controller configuration. */
export interface ControllerConfig {
  /** Force CPU-only planning regardless of probe. Default false. */
  cpuOnly?: boolean;
  /** Allow routing to a remote executor. Default false (local-only). */
  allowRemote?: boolean;
  /** Heterogeneous plans must beat the CPU-only estimate by this margin. Default 0.05 (5%). */
  heterogeneityMargin?: number;
  /** Per-transfer-point fixed sync penalty in ms. Default 4. */
  transferSyncPenaltyMs?: number;
  /** Optional decision logger (explainability sink). */
  onDecision?: (decision: ExecutionDecision) => void;
  /** Test hook: override the probed hardware profile. */
  hardwareOverride?: HardwareProfile;
}

/** Minimal executor surface the controller drives (matches InferenceClient). */
export interface ExecutorLike {
  load(model: { id: string; paramsB: number; quantization: string }): Promise<unknown>;
  generate(
    model: { id: string; paramsB: number; quantization: string },
    options: { prompt: string; maxTokens: number; signal?: AbortSignal },
  ): AsyncIterable<{ token: string }> & { stats?: () => Promise<{ ttftMs: number; tokensPerSecond: number }> };
}

export type { Quantization } from '../inference/types.js';
