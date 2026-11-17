/**
 * Phase 5 — Advanced Model & KV Cache Optimization: shared types.
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 * Decoupled from `src/inference/` (which only knows HOW to run) and from
 * `src/adaptive/` (which only decides WHERE/HOW). This module owns KV reuse,
 * quantization-aware execution, and gated advanced decode paths.
 */

/** Quantization formats Phase 5 routes on. `fp16` is local to this module. */
export type KvQuantization = 'q4' | 'q5' | 'q8' | 'fp16';

/** Backend kinds a quant plan may target. Matches Phase 1 `BackendKind`. */
export type KvBackendKind = 'onnx' | 'wllama' | 'webllm' | 'mock';

/**
 * Everything that MUST match before any KV state is reused.
 * Semantic / approximate retrieval is intentionally NOT a match criterion.
 */
export interface CompatibilityParts {
  /** Model identity (id). */
  modelId: string;
  /** Weight-file / checksum identity. Different weights ⇒ no reuse. */
  weightsHash: string;
  /** Tokenizer identity (vocab + special-token layout). */
  tokenizerId: string;
  /** Positional encoding config, e.g. `rope:theta=10000:scale=1`. */
  positionalConfig: string;
  /** Attention config, e.g. `mha:heads=32:kvHeads=8:headDim=64`. */
  attentionConfig: string;
}

/** Compatibility key with a canonical string form used as a map key. */
export interface CompatibilityKey extends CompatibilityParts {
  /** Canonical encoding of the five parts. */
  key: string;
}

export type OptimizationFlag =
  | 'prefixCache'
  | 'preconvertQuant'
  | 'speculativeDecoding'
  | 'continuousBatching'
  | 'activationSparsity';

export interface AdvancedCapabilities {
  speculativeDecoding: boolean;
  continuousBatching: boolean;
  activationSparsity: boolean;
  /** Draft model present — required for speculative decoding. */
  hasDraftModel: boolean;
  /** Fraction of activations that are zero/skippable (0 = dense). */
  sparsityFraction: number;
  /**
   * Model family. Architecture-specific opts are refused on incompatible
   * families (e.g. speculative decoding is decoder-transformer only).
   */
  architecture: string;
}

export interface QuantPlan {
  native: KvQuantization;
  runtime: KvQuantization;
  converted: boolean;
  conversionCost: number;
  bytesPerParam: number;
}

export interface KvModelRef {
  id: string;
  quantization: KvQuantization;
  paramsB?: number;
  weightsHash?: string;
}

export interface KvGenerateRequest {
  tokens: number[];
  /** Decode steps after prefill. Default 0. */
  maxNewTokens?: number;
  model: KvModelRef;
  tokenizerId: string;
  positionalConfig: string;
  attentionConfig: string;
  /**
   * Session identifier. Compatible sessions SHARE the cache — this is
   * deliberately NOT part of the compatibility key.
   */
  sessionId?: string;
  /** Optional text used by an injectable quality scorer. */
  output?: string;
  baselineOutput?: string;
}

export interface KvGenerateResult {
  output: string;
  compatibilityKey: string;
  cachedTokens: number;
  computeTokens: number;
  simulatedMs: number;
  bandwidthBytes: number;
  qualityScore: number;
  withinTolerance: boolean;
  servedFromCache: boolean;
  optimizationsApplied: OptimizationFlag[];
  evictedPages: number;
  quantPlan: QuantPlan;
}

export type QualityScorer = (input: {
  output: string;
  baselineOutput: string;
  quantization: KvQuantization;
  baselineQuantization: KvQuantization;
}) => number;

export interface KvCostModel {
  cacheHitPerToken: number;
  computePerToken: number;
  conversionPerToken: number;
  draftPerToken: number;
  verifyPerToken: number;
}

export interface KvCacheStats {
  hits: number;
  misses: number;
  pages: number;
  bytes: number;
  evictions: number;
  /** Distinct recently seen session ids (bounded by `maxSessions`). */
  sessions: number;
}

export interface KvCacheRuntimeOptions {
  maxBytes?: number;
  pageTokens?: number;
  flags?: Partial<Record<OptimizationFlag, boolean>>;
  capabilities?: Partial<AdvancedCapabilities>;
  qualityScorer?: QualityScorer;
  qualityBaseline?: KvQuantization;
  qualityTolerance?: number;
  now?: () => number;
  costs?: Partial<KvCostModel>;
  layers?: number;
  kvDim?: number;
  /** Draft-token block size when speculative decoding is active. */
  draftLen?: number;
  /** 0..1 fraction of draft tokens accepted (injected; tests set 1). */
  draftAccuracy?: number;
  /** Target format when `preconvertQuant` is on. Default `q4`. */
  preconvertTo?: KvQuantization;
  /**
   * Distinct session ids remembered for `stats().sessions`, least recently
   * seen forgotten first. Default 1024.
   */
  maxSessions?: number;
}

export interface KvCacheRuntime {
  generate(request: KvGenerateRequest): Promise<KvGenerateResult>;
  generateBatch(requests: KvGenerateRequest[]): Promise<KvGenerateResult[]>;
  lookup(request: KvGenerateRequest): { matched: number; key: string };
  setEnabled(flag: OptimizationFlag, enabled: boolean): void;
  isEnabled(flag: OptimizationFlag): boolean;
  stats(): KvCacheStats;
  clear(): void;
}
