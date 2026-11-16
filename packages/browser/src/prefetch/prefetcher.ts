/**
 * Phase 4 — Predictive Prefetching & Streaming: the prefetcher.
 *
 * Loads data the workload is *about* to need, ahead of the request that needs
 * it, so the request finds the data already resident. This is an optimization
 * layer, deliberately decoupled from every other phase:
 *
 *   - It never decides WHEN to run a workload (that is `src/adaptive/`).
 *   - It never calls an inference backend (that is `src/inference/`).
 *   - It never owns residency (that is `src/memory/`) — it only READS a
 *     pressure signal (the Phase 3 residency manager's `pressure().pressured`,
 *     or any injected `shouldThrottle()`).
 *
 * Invariants:
 *   - A prefetch NEVER blocks the active request: the load happens in the
 *     background, and the caller only ever waits for data it asked for.
 *   - Under pressure (the injected callback returns true) no new prefetch
 *     starts, in-flight speculative loads are dropped, and prefetched data
 *     nobody used is released. This is what keeps prefetching from thrashing
 *     memory or competing with active inference.
 *   - At most `maxConcurrent` speculative prefetches run at once.
 *   - The self-tuner disables prefetching when the MEASURED benefit is
 *     repeatedly negative (wasted speculative work outweighs avoided waits).
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 */

import type {
  PrefetchConfig,
  PrefetchContext,
  PrefetchEvent,
  PrefetchOutcome,
  PrefetchPrediction,
  PrefetchReason,
  PrefetchRequestResult,
  PrefetchSkipReason,
  PrefetchStats,
  PrefetchTarget,
  Prefetcher,
  ShouldThrottle,
} from './types.js';
import {
  mergePredictions,
  predictFromContext,
  predictFromGraph,
  predictFromHistory,
  type TargetIndex,
} from './predictor.js';

interface LoadRecord {
  id: string;
  controller: AbortController;
  promise: Promise<unknown>;
  bytes: number;
  /** Which strategy produced this load (for the explainable event log). */
  strategy: PrefetchReason;
  /** True when the load was started speculatively (a prefetch). */
  speculative: boolean;
  /** True when a request has attached to this in-flight load. */
  joined: boolean;
  /** True when a request consumed the loaded data. */
  claimed: boolean;
  completed: boolean;
  /** Wall-clock ms the load took. */
  loadMs: number;
  startedAt: number;
}

interface ResidentEntry {
  value: unknown;
  bytes: number;
  loadedAt: number;
  loadMs: number;
  /** 'prefetch' when the data was loaded speculatively, 'demand' otherwise. */
  source: 'prefetch' | 'demand';
  /** True when a request consumed the loaded data. */
  claimed: boolean;
}

/** Internal result of trying to start a speculative load. */
type StartResult = 'started' | 'duplicate' | 'throttled';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_TARGETS_PER_REQUEST = 8;
const DEFAULT_HISTORY_WINDOW = 32;
const DEFAULT_MIN_CONFIDENCE = 0.2;
const DEFAULT_EVENT_LIMIT = 128;
const DEFAULT_DISABLE_AFTER = 3;
const DEFAULT_MIN_SAMPLES = 3;

export function createPrefetcher(config: PrefetchConfig): Prefetcher {
  const loader = config.loader;
  if (typeof loader !== 'function') {
    throw new Error('createPrefetcher: config.loader is required');
  }
  const shouldThrottle: ShouldThrottle = config.shouldThrottle ?? (() => false);
  const maxConcurrent = Math.max(1, config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const maxTargetsPerRequest = Math.max(1, config.maxTargetsPerRequest ?? DEFAULT_MAX_TARGETS_PER_REQUEST);
  const historyWindow = Math.max(2, config.historyWindow ?? DEFAULT_HISTORY_WINDOW);
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const eventLogLimit = Math.max(1, config.eventLogLimit ?? DEFAULT_EVENT_LIMIT);
  const now = config.now ?? defaultNow;
  const disableAfter = Math.max(1, config.tuning?.disableAfter ?? DEFAULT_DISABLE_AFTER);
  const minSamples = Math.max(1, config.tuning?.minSamples ?? DEFAULT_MIN_SAMPLES);
  const retryAfterMs = Math.max(0, config.tuning?.retryAfterMs ?? 0);
  const residentBudgetBytes = config.residentBudgetBytes ?? Number.POSITIVE_INFINITY;

  const index: TargetIndex = new Map();
  for (const target of config.targets ?? []) index.set(target.id, target);

  const resident = new Map<string, ResidentEntry>();
  const inFlight = new Map<string, LoadRecord>();
  const history: string[] = [];
  const eventLog: PrefetchEvent[] = [];

  let hits = 0;
  let misses = 0;
  let prefetchHits = 0;
  let attempts = 0;
  let completed = 0;
  let throttled = 0;
  let cancelled = 0;
  let failed = 0;
  let skipped = 0;
  let totalWaitMs = 0;
  let waitSamples = 0;
  let totalLoadMs = 0;
  let loadSamples = 0;
  let peakConcurrent = 0;

  let enabled = config.enabled !== false;
  let selfTunedOff = false;
  let selfTuneTrips = 0;

  // Self-tuner state. The measurement is CUMULATIVE, not per-window: the
  // benefit a prefetch delivered (the wait it saved) against the cost of the
  // speculative loads nobody ever used. A speculative load stays "waste"
  // until a request claims it, so a prefetch that is never used keeps
  // counting against the tuner for as long as it is outstanding.
  let avoidedMs = 0;
  let measuredRequests = 0;
  let negativeStreak = 0;
  let disabledAt = 0;
  const unclaimedLoads: LoadRecord[] = [];

  function recordEvent(event: Omit<PrefetchEvent, 'at'>): void {
    const full: PrefetchEvent = { ...event, at: now() };
    eventLog.push(full);
    if (eventLog.length > eventLogLimit) eventLog.splice(0, eventLog.length - eventLogLimit);
    config.onEvent?.(full);
  }

  function rememberTarget(target: PrefetchTarget): void {
    if (!index.has(target.id)) index.set(target.id, target);
  }

  function isPressure(): boolean {
    try {
      return shouldThrottle() === true;
    } catch {
      // A misbehaving pressure callback must never break inference.
      return false;
    }
  }

  function speculativeCount(): number {
    let count = 0;
    for (const rec of inFlight.values()) if (rec.speculative) count += 1;
    return count;
  }

  function residentBytes(): number {
    let total = 0;
    for (const entry of resident.values()) total += entry.bytes;
    return total;
  }

  /** Release prefetched data nobody asked for — the memory-pressure relief. */
  function releaseUnclaimed(): number {
    let released = 0;
    for (const [id, entry] of [...resident.entries()]) {
      if (entry.source !== 'prefetch' || entry.claimed) continue;
      resident.delete(id);
      released += 1;
    }
    return released;
  }

  /** Keep the resident set inside its budget by dropping unclaimed prefetches. */
  function enforceResidentBudget(): void {
    if (residentBytes() <= residentBudgetBytes) return;
    const candidates = [...resident.entries()]
      .filter(([, entry]) => entry.source === 'prefetch' && !entry.claimed)
      .sort((a, b) => a[1].loadedAt - b[1].loadedAt);
    for (const [id] of candidates) {
      if (residentBytes() <= residentBudgetBytes) break;
      resident.delete(id);
    }
  }

  /** Drop speculative loads that nobody joined (pressure relief). */
  function dropUnjoinedPrefetches(): number {
    let dropped = 0;
    for (const rec of [...inFlight.values()]) {
      if (!rec.speculative || rec.joined) continue;
      rec.controller.abort();
      dropped += 1;
    }
    return dropped;
  }

  function onLoaded(rec: LoadRecord, value: unknown): void {
    rec.completed = true;
    rec.loadMs = Math.max(0, now() - rec.startedAt);
    inFlight.delete(rec.id);
    totalLoadMs += rec.loadMs;
    loadSamples += 1;
    completed += 1;
    resident.set(rec.id, {
      value,
      bytes: rec.bytes,
      loadedAt: now(),
      loadMs: rec.loadMs,
      source: rec.speculative ? 'prefetch' : 'demand',
      claimed: false,
    });
    if (rec.speculative) unclaimedLoads.push(rec);
    recordEvent({
      id: rec.id,
      strategy: rec.strategy,
      outcome: 'loaded',
      durationMs: rec.loadMs,
    });
    enforceResidentBudget();
  }

  function onFailed(rec: LoadRecord, error: unknown): void {
    rec.completed = true;
    rec.loadMs = Math.max(0, now() - rec.startedAt);
    inFlight.delete(rec.id);
    const aborted = rec.controller.signal.aborted
      || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      cancelled += 1;
      recordEvent({
        id: rec.id,
        strategy: rec.strategy,
        outcome: 'cancelled',
        durationMs: rec.loadMs,
      });
      return;
    }
    failed += 1;
    recordEvent({
      id: rec.id,
      strategy: rec.strategy,
      outcome: 'failed',
      durationMs: rec.loadMs,
    });
  }

  function startLoad(
    target: PrefetchTarget,
    options: { speculative: boolean; strategy: PrefetchReason; signal?: AbortSignal },
  ): LoadRecord {
    const controller = new AbortController();
    const startedAt = now();
    const forward = () => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    const promise = (async () => loader(target, controller.signal))();
    const rec: LoadRecord = {
      id: target.id,
      controller,
      promise,
      bytes: target.bytes,
      strategy: options.strategy,
      speculative: options.speculative,
      joined: false,
      claimed: false,
      completed: false,
      loadMs: 0,
      startedAt,
    };
    inFlight.set(target.id, rec);
    promise.then(
      (value) => {
        options.signal?.removeEventListener('abort', forward);
        onLoaded(rec, value);
      },
      (error: unknown) => {
        options.signal?.removeEventListener('abort', forward);
        onFailed(rec, error);
      },
    );
    return rec;
  }

  function noteConcurrency(): void {
    const count = speculativeCount();
    if (count > peakConcurrent) peakConcurrent = count;
  }

  /** Total ms of speculative load time that no request has claimed. */
  function unclaimedWasteMs(): number {
    let total = 0;
    for (const rec of unclaimedLoads) {
      if (!rec.claimed) total += rec.loadMs;
    }
    return total;
  }

  /** Evaluate the self-tuner. Called after each measured request. */
  function evaluateTuner(): void {
    measuredRequests += 1;

    // A self-tuned-off prefetcher may be re-enabled by the retry window.
    if (!enabled && selfTunedOff && retryAfterMs > 0 && now() - disabledAt >= retryAfterMs) {
      enabled = true;
      selfTunedOff = false;
      negativeStreak = 0;
      avoidedMs = 0;
      unclaimedLoads.length = 0;
      return;
    }

    if (measuredRequests < minSamples) return;
    const waste = unclaimedWasteMs();
    // Negative means the speculative work cost more than it saved. The
    // comparison is cumulative: waste only falls when a request claims the
    // load, and avoided only rises when a prefetch actually saved a wait.
    negativeStreak = waste > avoidedMs ? negativeStreak + 1 : 0;
    if (negativeStreak >= disableAfter && !selfTunedOff) {
      selfTunedOff = true;
      selfTuneTrips += 1;
      enabled = false;
      disabledAt = now();
      dropUnjoinedPrefetches();
      releaseUnclaimed();
      recordEvent({
        id: '*',
        strategy: 'explicit',
        outcome: 'throttled',
        durationMs: 0,
        skipReason: 'disabled',
      });
    }
  }

  /** Credit the wait a prefetch saved the caller. */
  function creditAvoidedWait(entry: ResidentEntry | undefined, actualWaitMs: number): void {
    if (!entry || entry.source !== 'prefetch') return;
    // A demand load of the same data would have cost about `loadMs`; the
    // prefetch saved the caller whatever it did not have to wait for.
    avoidedMs += Math.max(0, entry.loadMs - actualWaitMs);
  }

  function markClaimed(id: string): void {
    // A claimed load was not waste: remove it from the outstanding set.
    for (let i = unclaimedLoads.length - 1; i >= 0; i -= 1) {
      const rec = unclaimedLoads[i]!;
      if (rec.id !== id) continue;
      rec.claimed = true;
      unclaimedLoads.splice(i, 1);
    }
    const entry = resident.get(id);
    if (entry) entry.claimed = true;
  }

  function pushHistory(id: string): void {
    history.push(id);
    while (history.length > historyWindow) history.shift();
  }

  function autoPredict(targetId: string): PrefetchPrediction[] {
    // History + static graph only: no caller profile is available here.
    const predictions = mergePredictions(
      [predictFromGraph(targetId, config.graph, index), predictFromHistory(history, index)],
      minConfidence,
    );
    if (predictions.length === 0) return [];
    return startPredictions(predictions);
  }

  function startPredictions(predictions: readonly PrefetchPrediction[]): PrefetchPrediction[] {
    const acted: PrefetchPrediction[] = [];
    for (const prediction of predictions) {
      if (acted.length >= maxTargetsPerRequest) break;
      const result = startPrefetch(prediction);
      if (result === 'started' || result === 'duplicate') acted.push(prediction);
    }
    return acted;
  }

  function skipReasonFor(result: StartResult): PrefetchSkipReason {
    switch (result) {
      case 'duplicate':
        return 'already-loaded';
      case 'throttled':
        return 'pressure';
      default:
        return 'unknown-target';
    }
  }

  function startPrefetch(prediction: PrefetchPrediction): StartResult {
    const target = prediction.target;
    rememberTarget(target);
    attempts += 1;
    if (!enabled) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy: prediction.strategy,
        outcome: 'skipped',
        durationMs: 0,
        skipReason: 'disabled',
      });
      return 'throttled';
    }
    if (isPressure()) {
      throttled += 1;
      dropUnjoinedPrefetches();
      releaseUnclaimed();
      enforceResidentBudget();
      recordEvent({
        id: target.id,
        strategy: prediction.strategy,
        outcome: 'throttled',
        durationMs: 0,
        skipReason: 'pressure',
      });
      return 'throttled';
    }
    if (resident.has(target.id)) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy: prediction.strategy,
        outcome: 'duplicate',
        durationMs: 0,
        skipReason: 'already-loaded',
      });
      return 'duplicate';
    }
    const existing = inFlight.get(target.id);
    if (existing) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy: prediction.strategy,
        outcome: 'duplicate',
        durationMs: 0,
        skipReason: 'already-loading',
      });
      return 'duplicate';
    }
    if (speculativeCount() >= maxConcurrent) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy: prediction.strategy,
        outcome: 'skipped',
        durationMs: 0,
        skipReason: 'concurrency-limit',
      });
      return 'throttled';
    }
    startLoad(target, { speculative: true, strategy: prediction.strategy });
    noteConcurrency();
    return 'started';
  }

  async function request(
    target: PrefetchTarget,
    options?: { signal?: AbortSignal },
  ): Promise<PrefetchRequestResult> {
    rememberTarget(target);
    const startedAt = now();
    let hit = false;
    let value: unknown;
    let creditEntry: ResidentEntry | undefined;

    const residentEntry = resident.get(target.id);
    const inFlightRecord = inFlight.get(target.id);

    if (residentEntry) {
      hit = true;
      value = residentEntry.value;
      creditEntry = residentEntry;
      markClaimed(target.id);
    } else if (inFlightRecord) {
      // A prefetch is already in flight: join it rather than starting a
      // second load for the same data.
      hit = true;
      inFlightRecord.joined = true;
      try {
        value = await inFlightRecord.promise;
        creditEntry = resident.get(target.id);
        markClaimed(target.id);
      } catch {
        // The prefetch was cancelled (e.g. under pressure) — fall back to a
        // fresh on-demand load so the caller is never left without data.
        hit = false;
        const rec = startLoad(target, { speculative: false, strategy: 'explicit', signal: options?.signal });
        value = await rec.promise;
      }
    } else {
      hit = false;
      const rec = startLoad(target, { speculative: false, strategy: 'explicit', signal: options?.signal });
      value = await rec.promise;
    }

    const waitMs = Math.max(0, now() - startedAt);
    if (hit) {
      hits += 1;
      if (creditEntry?.source === 'prefetch') prefetchHits += 1;
    } else {
      misses += 1;
    }
    totalWaitMs += waitMs;
    waitSamples += 1;
    creditAvoidedWait(creditEntry, waitMs);

    pushHistory(target.id);
    evaluateTuner();

    // Predict what the workload will need NEXT and start it in the
    // background. The caller never waits for this.
    const predicted = autoPredict(target.id);

    return { hit, value, waitMs, predicted };
  }

  function requestById(id: string, options?: { signal?: AbortSignal }): Promise<PrefetchRequestResult> {
    const known = index.get(id);
    return request(known ?? { id, bytes: 0 }, options);
  }

  function predict(context: PrefetchContext, options?: { signal?: AbortSignal }): PrefetchPrediction[] {
    const predictions = mergePredictions(
      [
        predictFromGraph(context.target, config.graph, index),
        predictFromHistory(history, index),
        predictFromContext(context, index),
      ],
      minConfidence,
    );
    if (predictions.length === 0) return [];
    if (options?.signal?.aborted) return [];
    const acted = startPredictions(predictions);
    // A prediction can be invalidated: aborting the signal cancels the
    // speculative loads that were started for it.
    const signal = options?.signal;
    if (signal) {
      const started: LoadRecord[] = [];
      for (const prediction of acted) {
        const rec = inFlight.get(prediction.target.id);
        if (rec && rec.speculative) started.push(rec);
      }
      if (started.length > 0) {
        const forward = () => {
          for (const rec of started) rec.controller.abort();
        };
        signal.addEventListener('abort', forward, { once: true });
        void Promise.allSettled(started.map((rec) => rec.promise)).then(() => {
          signal.removeEventListener('abort', forward);
        });
      }
    }
    return acted;
  }

  function prefetch(
    target: PrefetchTarget,
    options?: { signal?: AbortSignal; strategy?: PrefetchReason },
  ): Promise<PrefetchOutcome> {
    rememberTarget(target);
    attempts += 1;
    const strategy: PrefetchReason = options?.strategy ?? 'explicit';
    if (!enabled) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy,
        outcome: 'skipped',
        durationMs: 0,
        skipReason: 'disabled',
      });
      return Promise.resolve('throttled');
    }
    if (isPressure()) {
      throttled += 1;
      dropUnjoinedPrefetches();
      releaseUnclaimed();
      enforceResidentBudget();
      recordEvent({
        id: target.id,
        strategy,
        outcome: 'throttled',
        durationMs: 0,
        skipReason: 'pressure',
      });
      return Promise.resolve('throttled');
    }
    if (resident.has(target.id)) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy,
        outcome: 'duplicate',
        durationMs: 0,
        skipReason: 'already-loaded',
      });
      return Promise.resolve('duplicate');
    }
    if (inFlight.has(target.id)) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy,
        outcome: 'duplicate',
        durationMs: 0,
        skipReason: 'already-loading',
      });
      return Promise.resolve('duplicate');
    }
    if (speculativeCount() >= maxConcurrent) {
      skipped += 1;
      recordEvent({
        id: target.id,
        strategy,
        outcome: 'skipped',
        durationMs: 0,
        skipReason: 'concurrency-limit',
      });
      return Promise.resolve('throttled');
    }
    const rec = startLoad(target, { speculative: true, strategy, signal: options?.signal });
    noteConcurrency();
    return rec.promise.then(
      () => 'loaded' as PrefetchOutcome,
      () => (rec.controller.signal.aborted ? 'cancelled' as PrefetchOutcome : 'failed' as PrefetchOutcome),
    );
  }

  function cancelAll(): void {
    for (const rec of [...inFlight.values()]) {
      if (!rec.speculative) continue;
      rec.controller.abort();
    }
    releaseUnclaimed();
  }

  function cancel(targetId: string): void {
    const rec = inFlight.get(targetId);
    if (rec && rec.speculative) rec.controller.abort();
    const entry = resident.get(targetId);
    if (entry && entry.source === 'prefetch' && !entry.claimed) resident.delete(targetId);
  }

  function stats(): PrefetchStats {
    const total = hits + misses;
    return {
      hits,
      misses,
      prefetchHits,
      attempts,
      completed,
      throttled,
      cancelled,
      failed,
      skipped,
      hitRate: total === 0 ? 0 : hits / total,
      totalWaitMs,
      waitMs: waitSamples === 0 ? 0 : totalWaitMs / waitSamples,
      avgLoadMs: loadSamples === 0 ? 0 : totalLoadMs / loadSamples,
      inFlight: inFlight.size,
      maxConcurrent: peakConcurrent,
      residentBytes: residentBytes(),
      selfTunedOff,
      selfTuneTrips,
    };
  }

  return {
    request,
    requestById,
    predict,
    prefetch,
    cancelAll,
    cancel,
    stats,
    hitRate: () => stats().hitRate,
    waitMs: () => stats().waitMs,
    events: () => eventLog,
    residentIds: () => [...resident.keys()],
    isEnabled: () => enabled,
    setEnabled(next: boolean) {
      enabled = next;
      if (!enabled) cancelAll();
    },
    /** Resolve once no loads are in flight (test / diagnostic helper). */
    async whenIdle(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()].map((rec) => rec.promise));
      }
    },
  };
}

function defaultNow(): number {
  const g = globalThis as { performance?: { now(): number } };
  return g.performance?.now?.() ?? Date.now();
}
