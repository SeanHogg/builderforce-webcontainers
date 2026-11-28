/**
 * `@seanhogg/builderforce-webcontainers/ml` — the in-browser ML runtime: local
 * inference (client, worker host, backends, model cache), the adaptive
 * execution controller, memory residency, the knowledge/retrieval layer,
 * prefetch, KV-cache optimisation and online learning. Kept off the package
 * root so dev-runtime consumers never load it. The inference worker bundle is
 * `@seanhogg/builderforce-webcontainers/ml/worker.js`.
 */
export { createInferenceClient } from './inference/client.js';
export type { InferenceClient, InferenceClientOptions, InferenceWorkerLike } from './inference/client.js';
export { createModelCache, createMemoryModelCache } from './inference/modelCache.js';
export type { ModelCache, ModelCacheEntry, ModelCacheOptions, ModelCacheValueFormat } from './inference/modelCache.js';
export { createOnnxBackend } from './inference/backends/onnx.js';
export type { OnnxBackendOptions, OrtWasmModule, OrtSession } from './inference/backends/onnx.js';
export { createWllamaBackend } from './inference/backends/wllama.js';
export type { WllamaBackendOptions, WllamaModule, WllamaModel } from './inference/backends/wllama.js';
export { createWebLlmBackend } from './inference/backends/webllm.js';
export type { WebLlmBackendOptions, WebLlmModule, WebLlmModel } from './inference/backends/webllm.js';
export { createMockBackend, MOCK_VOCAB } from './inference/backends/mock.js';
export type { MockBackendOptions } from './inference/backends/mock.js';
export { probeRuntimeCapabilities } from './inference/capabilities.js';
export { startInferenceWorkerHost, runInferenceWorker } from './inference/worker.js';
export type {
  BackendInfo,
  BackendKind,
  ChatMessage,
  GenerateOptions,
  GenerationStats,
  InferenceBackend,
  InferenceModel,
  InferenceToken,
  ModelRef,
  Quantization,
  RuntimeCapabilities,
} from './inference/types.js';
export { createAdaptiveController, probeHardware } from './adaptive/controller.js';
export type { AdaptiveController } from './adaptive/controller.js';
export { planExecution } from './adaptive/planner.js';
export type {
  ControllerConfig,
  ExecutionDecision,
  ExecutionGraph,
  ExecutionOutcome,
  ExecutionPlan,
  ExecutionStrategy,
  ExecutorLike,
  HardwareProfile,
  LayerNode,
  WorkloadProfile,
} from './adaptive/types.js';
export { createMemoryManager, probeRamBytes, probeStorageQuotaBytes } from './residency/manager.js';
export type { AdmitResult, MemoryManager, MemoryManagerOptions } from './residency/manager.js';
export { arcStrategy, costAwareStrategy, lfuStrategy, lruStrategy, retentionValue, strategyByName } from './residency/eviction.js';
export { bytesPerParam, estimateReloadCostMs, estimateReuseProbability, estimateWeightBytes } from './residency/estimates.js';
export type { ReloadCostInput, ReuseObservation } from './residency/estimates.js';
export { detectPressure, planWorkspace } from './residency/pressure.js';
export type { PressureInput, WorkspaceBounds, WorkspaceDecision } from './residency/pressure.js';
export { createMemorySink, createModelCacheSink } from './residency/storageSink.js';
export type { SpilledRecord, StorageSink, StorageSinkOptions } from './residency/storageSink.js';
export type {
  AdmitOptions,
  EvictionStrategy,
  LookupResult,
  MemoryManagerConfig,
  MemoryPressure,
  Quota,
  ResidencyEvent,
  ResidencyEventKind,
  ResidencyStats,
  ResidencyTier,
  ResidentEntry,
  TrackedEntry,
} from './residency/types.js';
export {
  createKnowledgeMemory,
  createIndexedDbKnowledgePersistence,
  createMemoryKnowledgePersistence,
  chunkText as chunkKnowledgeText,
  normalizeText as normalizeKnowledgeText,
  contentHash as knowledgeContentHash,
  estimateTokens,
} from './memoryIntegration/index.js';
export type {
  KnowledgeMemory,
  KnowledgeMemoryOptions,
  KnowledgeMemoryStats,
  IndexedDbKnowledgePersistenceOptions,
  TextEmbedder,
  KnowledgeKind,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgePersistence,
  StoredKnowledgeDoc,
  StoredChunk,
  SourceReference,
  RetrieveOptions,
  ContextOptions,
  AssembledContext,
  IngestResult,
  RetentionPolicy,
  RerankHook,
} from './memoryIntegration/index.js';
export { createPrefetcher } from './prefetch/prefetcher.js';
export {
  mergePredictions,
  predictFromContext,
  predictFromGraph,
  predictFromHistory,
  PREFETCH_STRATEGIES,
} from './prefetch/predictor.js';
export {
  createDoubleBuffer,
  createPrefillStream,
  probeSupport,
  pumpDoubleBuffer,
} from './prefetch/streaming.js';
export type {
  DoubleBuffer,
  PrefillStream,
  PrefillStreamBackend,
  PrefillStreamOptions,
  PrefillStreamResult,
  PrefillToken,
  StreamChunk,
} from './prefetch/streaming.js';
export type {
  PrefetchConfig,
  PrefetchContext,
  PrefetchEvent,
  PrefetchGraph,
  PrefetchEdge,
  Prefetcher,
  PrefetchOutcome,
  PrefetchPrediction,
  PrefetchReason,
  PrefetchRequestResult,
  PrefetchSkipReason,
  PrefetchStats,
  PrefetchStrategy,
  PrefetchTarget,
  PrefetchTuningConfig,
  ShouldThrottle,
} from './prefetch/types.js';
export { createKvCacheRuntime } from './kvcache/runtime.js';
export {
  encodeCompatibilityKey,
  parseCompatibilityKey,
  compatibilityEquals,
  exactPrefixLength,
} from './kvcache/compatibility.js';
export { planQuantization, defaultQualityScorer, DEFAULT_QUALITY_TOLERANCE } from './kvcache/quant.js';
export type {
  AdvancedCapabilities,
  CompatibilityKey,
  CompatibilityParts,
  KvCacheRuntime,
  KvCacheRuntimeOptions,
  KvCacheStats,
  KvGenerateRequest,
  KvGenerateResult,
  KvQuantization,
  OptimizationFlag,
  QualityScorer,
  QuantPlan,
} from './kvcache/types.js';
export { createLearner, fingerprintWorkload, observationFromExecution } from './learning/index.js';
export { emptyStat, observeStat, ucb1, variance } from './learning/index.js';
export type {
  RunningStat,
  ConfigDeltaField,
  HistoryEntry,
  Learner,
  LearnerConfig,
  LearningStats,
  ObserveResult,
  OutcomeObservation,
  Recommendation,
  SafeStrategy,
  WorkloadFingerprintInput,
} from './learning/index.js';
