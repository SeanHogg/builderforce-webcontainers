/**
 * Phase 4 — Predictive Prefetching & Streaming: types.
 *
 * The prefetcher predicts WHICH data a workload will need next and loads it
 * asynchronously, ahead of the request that needs it. It is deliberately
 * decoupled from every other phase:
 *   - `src/inference/` only knows how to run; it never asks to prefetch.
 *   - `src/adaptive/` decides where/how to run; it never triggers a prefetch.
 *   - `src/residency/` owns residency; the prefetcher only *reads* a pressure
 *     signal from it (or an injected `shouldThrottle()`).
 *
 * Prefetching is an OPTIMIZATION, never a decision: a missed prediction must
 * cost exactly what the caller would have cost anyway, and a prefetch that
 * cannot be served is dropped, never queued behind the active request.
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 */

/** How a prediction was produced. */
export type PrefetchStrategy =
  /** Static dependency graph declared by the workload (e.g. "tokenizer" -> "model"). */
  | 'static-graph'
  /** Frequency/recency over observed accesses (Markov-ish next-item prediction). */
  | 'history'
  /** Derived from the caller's workload profile (model size, prompt shape, stage). */
  | 'context';

/** One thing the prefetcher can load. */
export interface PrefetchTarget {
  /** Stable key, e.g. `model:tiny-q4` or `asset:tokenizer.json`. */
  id: string;
  /** Estimated footprint in bytes — used for pressure accounting. */
  bytes: number;
  /** Optional kind hint for reporting. */
  kind?: 'model' | 'weights' | 'tokenizer' | 'asset' | 'graph';
  /** Extra information the loader understands (opaque to the prefetcher). */
  meta?: Record<string, unknown>;
}

/** A declaration of "if you need A, you will probably also need B". */
export interface PrefetchEdge {
  from: string;
  to: string;
  /** Relative likelihood in [0, 1]. Default 1. */
  weight?: number;
}

/** A declared static dependency graph (edges between target ids). */
export interface PrefetchGraph {
  edges: readonly PrefetchEdge[];
}

/** Caller-supplied context about the workload that is about to run. */
export interface PrefetchContext {
  /** The workload/model that is about to be used (its primary target id). */
  target: string;
  /** Optional profile hints used by the context strategy. */
  profile?: {
    /** Model size in billions of parameters. */
    paramsB?: number;
    /** Quantization bucket, matching `ModelRef.quantization`. */
    quantization?: 'q4' | 'q5' | 'q8' | 'fp16';
    /** Stage of the workload — used to predict the NEXT stage's needs. */
    stage?: 'prefill' | 'decode' | 'postprocess';
    /** Free-form workload labels, e.g. `['rag', 'code']`. */
    labels?: readonly string[];
    /** Explicit extra ids the caller expects to need soon. */
    expects?: readonly string[];
  };
}

/** Why a prefetch was started. */
export type PrefetchReason =
  | 'static-graph'
  | 'history'
  | 'context'
  | 'explicit';

/** Load one target. The prefetcher never interprets the result. */
export type PrefetchLoader = (target: PrefetchTarget, signal: AbortSignal) => Promise<unknown>;

/** Pressure signal: return true to stop prefetching right now. */
export type ShouldThrottle = () => boolean;

/** Outcome of a single prefetch attempt. */
export type PrefetchOutcome =
  | 'hit'
  | 'loaded'
  | 'throttled'
  | 'cancelled'
  | 'duplicate'
  | 'failed'
  | 'skipped';

/** Why a prefetch was skipped or dropped. */
export type PrefetchSkipReason =
  | 'disabled'
  | 'pressure'
  | 'concurrency-limit'
  | 'already-loading'
  | 'already-loaded'
  /**
   * A prediction named an id that is not in the target index (never declared, or
   * learned and since forgotten). Its footprint is unknown, so it is not loaded
   * speculatively; supply it via `request(target)` / `prefetch(target)` instead.
   */
  | 'unknown-target'
  | 'cancelled';

/** One recorded prefetch event (bounded log). */
export interface PrefetchEvent {
  id: string;
  strategy: PrefetchReason;
  outcome: PrefetchOutcome;
  /** Wall-clock ms spent loading (0 when the load never started). */
  durationMs: number;
  /** Why it was skipped, when it was not loaded. */
  skipReason?: PrefetchSkipReason;
  at: number;
}

/** Aggregate counters. `hitRate` is hits / (hits + misses). */
export interface PrefetchStats {
  /** Number of times a requested target was already resident (prefetch win). */
  hits: number;
  /** Number of times a requested target had to be loaded on demand. */
  misses: number;
  /**
   * Hits where the resident copy came from a SPECULATIVE prefetch (as opposed
   * to a previous demand load). This is the number that measures whether
   * prefetching actually paid off.
   */
  prefetchHits: number;
  /** Total prefetch attempts (loaded + skipped + failed). */
  attempts: number;
  /** Loads that completed successfully — speculative prefetches AND demand loads (`request` misses). */
  completed: number;
  /** Prefetches dropped because the environment was under pressure. */
  throttled: number;
  /** Prefetches aborted by an invalidating signal. */
  cancelled: number;
  /** Prefetches that errored. */
  failed: number;
  /** Prefetches skipped because the target was already in flight / resident. */
  skipped: number;
  /** hits / (hits + misses); 0 when nothing was requested. */
  hitRate: number;
  /** Total ms the caller spent WAITING for data (0 when every request was a hit). */
  totalWaitMs: number;
  /** Mean ms the caller waited per request (0 when nothing was requested). */
  waitMs: number;
  /** Mean ms a prefetch took to load. */
  avgLoadMs: number;
  /** Prefetches currently in flight. */
  inFlight: number;
  /** Peak concurrent prefetches observed. */
  maxConcurrent: number;
  /** Total bytes of every resident value (prefetched and demand-loaded). */
  residentBytes: number;
  /** Whether the self-tuner has turned prefetching off. */
  selfTunedOff: boolean;
  /** Number of times the self-tuner turned prefetching off. */
  selfTuneTrips: number;
}

/** Self-tuner configuration. */
export interface PrefetchTuningConfig {
  /**
   * Consecutive measurements with non-positive measured benefit before
   * prefetching is disabled. Default 3.
   */
  disableAfter?: number;
  /**
   * Minimum number of measurements before the tuner may act. Default 3.
   */
  minSamples?: number;
  /** Re-enable automatically after this many ms. 0 disables re-enabling. Default 0. */
  retryAfterMs?: number;
  /**
   * Outstanding (unclaimed) speculative loads tracked individually. Older ones
   * still count as waste but are folded into a single total. Default 256.
   */
  maxTrackedLoads?: number;
}

/** Prefetcher configuration. */
export interface PrefetchConfig {
  /** Load function. Required — the prefetcher never fetches anything itself. */
  loader: PrefetchLoader;
  /**
   * Pressure gate. When it returns true, no prefetch starts and in-flight
   * prefetches are dropped. Defaults to "never under pressure".
   */
  shouldThrottle?: ShouldThrottle;
  /**
   * Static dependency graph. Targets reachable from a requested id are
   * prefetched with the `static-graph` strategy.
   */
  graph?: PrefetchGraph;
  /** Known target footprints, so pressure accounting and prediction can size things. */
  targets?: readonly PrefetchTarget[];
  /** Maximum number of concurrent prefetches. Default 2. */
  maxConcurrent?: number;
  /** Maximum number of targets prefetched for one request. Default 8. */
  maxTargetsPerRequest?: number;
  /** History window size (number of observed accesses kept). Default 32. */
  historyWindow?: number;
  /** Minimum confidence (0..1) for a prediction to be acted on. Default 0.2. */
  minConfidence?: number;
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * Byte budget for EVERY resident value — speculative prefetches and demand
   * loads, claimed or not. When the resident set exceeds it, unclaimed
   * prefetches are dropped first (oldest first), then the least recently used
   * values. Default: no byte bound (the entry cap still applies).
   */
  residentBudgetBytes?: number;
  /** Cap on the number of resident values, evicted in the same order. Default 1024. */
  maxResidentEntries?: number;
  /**
   * Cap on targets remembered at runtime (supplied to `request` / `prefetch` but
   * not declared in `targets`). Oldest forgotten first; forgetting drops only the
   * metadata, never a resident value. Predictions do not teach the index.
   * Default 1024.
   */
  maxKnownTargets?: number;
  /** Self-tuner configuration. */
  tuning?: PrefetchTuningConfig;
  /** Clock for tests. Default: the shared monotonic clock (`performance.now`, else `Date.now`). */
  now?: () => number;
  /** Event sink for explainability (also recorded in the bounded log). */
  onEvent?: (event: PrefetchEvent) => void;
  /** Log capacity. Default 128. */
  eventLogLimit?: number;
}

/** A prediction the prefetcher made, with its confidence and origin. */
export interface PrefetchPrediction {
  target: PrefetchTarget;
  strategy: PrefetchReason;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Why it was predicted. */
  reason: string;
}

/** Result of requesting data through the prefetcher. */
export interface PrefetchRequestResult {
  /** True when the data was already resident (prefetch hit). */
  hit: boolean;
  /** The loaded value (whatever the loader returned). */
  value: unknown;
  /** ms spent waiting for the value (0 for a hit). */
  waitMs: number;
  /** Targets the prefetcher kicked off in the background for this request. */
  predicted: PrefetchPrediction[];
}

/** The public prefetcher surface. */
export interface Prefetcher {
  /**
   * Get a target, using a prefetched copy when one is resident and loading it
   * on demand otherwise. Records hit/miss and wait-time accounting.
   */
  request(target: PrefetchTarget, options?: { signal?: AbortSignal }): Promise<PrefetchRequestResult>;
  /**
   * Request by id; the target must be known (declared in `targets`, or learned at
   * runtime and not yet forgotten past `maxKnownTargets`). Rejects for an unknown id
   * — its footprint is unknown, so it could not be held to the resident byte budget;
   * use `request(target)` to supply (and relearn) it.
   */
  requestById(id: string, options?: { signal?: AbortSignal }): Promise<PrefetchRequestResult>;
  /**
   * Ask the prefetcher to predict and start loading what a workload will need
   * next. Returns the predictions it acted on.
   */
  predict(context: PrefetchContext, options?: { signal?: AbortSignal }): PrefetchPrediction[];
  /** Explicitly prefetch one target (bypasses prediction, not the pressure gate). */
  prefetch(target: PrefetchTarget, options?: { signal?: AbortSignal; strategy?: PrefetchReason }): Promise<PrefetchOutcome>;
  /** Cancel every in-flight prefetch and release unclaimed prefetched data. */
  cancelAll(reason?: string): void;
  /** Cancel in-flight prefetches for one target id. */
  cancel(targetId: string, reason?: string): void;
  /**
   * Drop a resident value — demand-loaded, claimed or prefetched — and its
   * resident bookkeeping (bytes, recency). In-flight loads are not affected
   * (use `cancel` for those). Returns whether something was dropped.
   */
  release(targetId: string): boolean;
  /** Current aggregate counters. */
  stats(): PrefetchStats;
  /** hits / (hits + misses). */
  hitRate(): number;
  /** Mean ms the caller waited for data. */
  waitMs(): number;
  /** Bounded, explainable event log, oldest first. */
  events(): readonly PrefetchEvent[];
  /** Resident target ids. */
  residentIds(): string[];
  /** True when the self-tuner has disabled prefetching. */
  isEnabled(): boolean;
  /** Turn prefetching on/off explicitly (overrides the self-tuner's decision). */
  setEnabled(enabled: boolean): void;
  /** Resolve once no loads are in flight (test / diagnostic helper). */
  whenIdle(): Promise<void>;
}
