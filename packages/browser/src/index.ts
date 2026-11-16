export { startPreviewRuntime } from './host.js';
export type {
  PreviewRuntimeOptions,
  SameOriginOptions,
  RelayOptions,
  CommonRuntimeOptions,
  PreviewRuntime,
  RuntimeBuildOptions,
} from './host.js';
export { listenToPreview } from './previewMessages.js';
export { createSnapshotStore } from './snapshotStore.js';
export type { SnapshotStore, SnapshotStoreOptions } from './snapshotStore.js';
export type { PreviewError, PreviewConsoleMessage, ConsoleLevel, PreviewMessages } from './previewMessages.js';
export { listenToPreviewBridge } from './previewBridge.js';
export type { PreviewBridge, PreviewBridgeOptions, BridgePort } from './previewBridge.js';
export type { PreviewTransport } from './transport.js';
export { createEsbuildWasmTransformer, createEsbuildWasmBundler, loadEsbuildWasm } from './esbuildWasm.js';
export type { EsbuildWasmOptions } from './esbuildWasm.js';
export { createCdnComponentCompilers, defaultVueCompilerUrl, defaultSvelteCompilerUrl } from './componentCompilers.js';
export type { CdnComponentCompilerOptions } from './componentCompilers.js';
export { createCdnStyleCompilers, defaultSassUrl, defaultLessUrl } from './styleCompilers.js';
export type { CdnStyleCompilerOptions } from './styleCompilers.js';
export { watchForPreviewUpdates } from './previewUpdates.js';
export { createCacheStoragePackageCache } from './packageCache.js';
export { ProcessHost, createWorkerProcess, servePortRequest, createPortResponder, openPortResponse, injectBridge } from './node/index.js';
export type { NodeRuntimeOptions, ProcessHostOptions, ProcessInfo, WorkerLike, PortResponder, PortResponderOptions, OpenedPortResponse } from './node/index.js';
export { createInferenceClient } from './inference/client.js';
export type { InferenceClient, InferenceClientOptions, InferenceWorkerLike } from './inference/client.js';
export { createModelCache, createMemoryModelCache } from './inference/modelCache.js';
export type { ModelCache, ModelCacheEntry } from './inference/modelCache.js';
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
export { createMemoryManager, probeRamBytes, probeStorageQuotaBytes } from './memory/manager.js';
export type { AdmitResult, MemoryManager, MemoryManagerOptions } from './memory/manager.js';
export { arcStrategy, costAwareStrategy, lfuStrategy, lruStrategy, retentionValue, strategyByName } from './memory/eviction.js';
export { bytesPerParam, estimateReloadCostMs, estimateReuseProbability, estimateWeightBytes } from './memory/estimates.js';
export type { ReloadCostInput, ReuseObservation } from './memory/estimates.js';
export { detectPressure, planWorkspace } from './memory/pressure.js';
export type { PressureInput, WorkspaceBounds, WorkspaceDecision } from './memory/pressure.js';
export { createMemorySink, createModelCacheSink } from './memory/storageSink.js';
export type { SpilledRecord, StorageSink, StorageSinkOptions } from './memory/storageSink.js';
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
} from './memory/types.js';
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
export { createSwRouter } from './swRouter.js';
export type { SwRouter, SwRouterOptions, PortLike, PreviewTarget, RoutedResponse, RequestDetails } from './swRouter.js';
export { previewBase, previewPrefix, PREVIEW_SEGMENT, PREVIEW_ID, PORT_SEGMENT, isPortPath } from './protocol.js';
export * from '@seanhogg/builderforce-webcontainers-core';
