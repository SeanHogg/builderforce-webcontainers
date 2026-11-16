/**
 * Phase 5 — Advanced Model & KV Cache Optimization.
 * Public surface. Additive only; nothing here mutates Phase 1/2 APIs.
 */

export { encodeCompatibilityKey, parseCompatibilityKey, compatibilityEquals, exactPrefixLength } from './compatibility.js';
export { LruCache } from './lru.js';
export type { LruNode } from './lru.js';
export { TokenRadix } from './radix.js';
export type { RadixMatch } from './radix.js';
export { PagedKvCache } from './paged.js';
export type { KvPage, PrefixHit } from './paged.js';
export {
  bytesPerParam,
  nativeQuality,
  planQuantization,
  backendSupports,
  bandwidthBytes,
  defaultQualityScorer,
  DEFAULT_QUALITY_TOLERANCE,
} from './quant.js';
export {
  isEnabled,
  canSpeculative,
  canContinuousBatch,
  canActivationSparsity,
  decodeCost,
  batchCost,
} from './advanced.js';
export { createKvCacheRuntime } from './runtime.js';
export type {
  KvQuantization,
  KvBackendKind,
  CompatibilityParts,
  CompatibilityKey,
  OptimizationFlag,
  AdvancedCapabilities,
  QuantPlan,
  KvModelRef,
  KvGenerateRequest,
  KvGenerateResult,
  QualityScorer,
  KvCostModel,
  KvCacheStats,
  KvCacheRuntimeOptions,
  KvCacheRuntime,
} from './types.js';
