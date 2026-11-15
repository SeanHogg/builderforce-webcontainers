/**
 * Phase 1 — Local CPU Inference Engine: model and capability types.
 *
 * The runtime abstraction lives in `types.ts`; this file holds the shared
 * shapes that cross the worker boundary and the capability probe results.
 */

/** Quantization formats a backend may support. */
export type Quantization = 'q4' | 'q5' | 'q8';

/** A reference to a local model asset. */
export interface ModelRef {
  /** Unique model identifier, e.g. `builderforce/tiny-instruct-q4`. */
  id: string;
  /** Parameter count (billions), used for tier recommendations. */
  paramsB: number;
  quantization: Quantization;
  /** Number of weights in the model (informational). */
  numWeights?: number;
  /** Where the model bytes live. `url` is fetched once at provisioning time. */
  source?: { kind: 'url'; url: string; bytes?: number };
}

/** Runtime/backend kinds the abstraction can host. */
export type BackendKind = 'onnx' | 'wllama' | 'webllm' | 'mock';

/** Backend + capability metadata returned by `probeCapabilities()`. */
export interface BackendInfo {
  kind: BackendKind;
  available: boolean;
  /** Human-readable reason when unavailable (e.g. "WebGPU not present"). */
  reason?: string;
  /** WASM SIMD usable by this backend (best-effort probe). */
  wasmSimd: boolean;
  /** WebGPU usable by this backend. */
  webgpu: boolean;
}

/** Everything the runtime could detect about the environment. */
export interface RuntimeCapabilities {
  wasm: boolean;
  wasmSimd: boolean;
  webgpu: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  backends: BackendInfo[];
}

/** A generated token, streamed back to the caller. */
export interface InferenceToken {
  token: string;
  /** Cumulative tokens generated so far in this request. */
  index: number;
}

/** Final stats for one `generate()` call. */
export interface GenerationStats {
  promptTokens: number;
  generatedTokens: number;
  /** Wall-clock ms from generate() call to first token. */
  ttftMs: number;
  /** Wall-clock ms from first token to stream end. */
  decodeMs: number;
  tokensPerSecond: number;
}

/** One message in a chat-style prompt. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options accepted by `generate()`. */
export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Public API of a loaded, ready-to-generate model instance. */
export interface InferenceModel {
  readonly ref: ModelRef;
  generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken>;
  /** Release backend resources; the instance is unusable after. */
  dispose(): Promise<void>;
}

/**
 * A backend plugin: it can report availability, load a model from cached
 * bytes, and generate tokens. The worker loop in `inference/worker.ts`
 * drives a single backend at a time; the host-side `InferenceClient`
 * (`inference/client.ts`) is what callers use.
 */
export interface InferenceBackend {
  readonly kind: BackendKind;
  probe(): Promise<BackendInfo>;
  load(model: ModelRef, weights: ArrayBuffer, context: BackendContext): Promise<void>;
  generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken>;
  dispose(): Promise<void>;
}

/** What a backend needs from its host environment. */
export interface BackendContext {
  /** Log lines go to the host as worker log messages (debugging only). */
  log(message: string): void;
  /** True when the host supports the SharedArrayBuffer fast path. */
  sharedArrayBuffer: boolean;
  wasmSimd: boolean;
  webgpu: boolean;
}
