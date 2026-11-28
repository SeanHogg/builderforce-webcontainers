/**
 * Phase 4 — Predictive Prefetching & Streaming: the prefetcher.
 *
 * Loads data the workload is *about* to need, ahead of the request that needs
 * it, so the request finds the data already resident. This is an optimization
 * layer, deliberately decoupled from every other phase:
 *
 *   - It never decides WHEN to run a workload (that is `src/adaptive/`).
 *   - It never calls an inference backend (that is `src/inference/`).
 *   - It never owns residency (that is `src/residency/`) — it only READS a
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
 *   - Every resident value (demand or prefetched, claimed or not) lives inside
 *     the resident byte budget and entry cap; the known-target index and the
 *     self-tuner's bookkeeping are bounded too.
 *   - The self-tuner disables prefetching when the MEASURED benefit is
 *     repeatedly negative (wasted speculative work outweighs avoided waits).
 *
 * This file composes the pieces; each concern lives in its own module:
 *   admission.ts (the one admission gate) · loadRegistry.ts (in-flight loads)
 *   residentStore.ts (budgeted resident values) · selfTuner.ts (benefit
 *   measurement) · stats.ts (counters + event log) · targetIndex.ts.
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 */

import { now as clockNow } from '../shared/clock.js';
import { createAdmissionGate } from './admission.js';
import { createLoadRegistry, type LoadRecord } from './loadRegistry.js';
import { mergePredictions, predictFromContext, predictFromGraph, predictFromHistory } from './predictor.js';
import { createResidentStore, type ResidentValue } from './residentStore.js';
import { createSelfTuner } from './selfTuner.js';
import { createPrefetchLedger } from './stats.js';
import { createTargetIndex } from './targetIndex.js';
import type {
  PrefetchConfig,
  PrefetchContext,
  PrefetchOutcome,
  PrefetchPrediction,
  PrefetchReason,
  PrefetchRequestResult,
  PrefetchStats,
  PrefetchTarget,
  Prefetcher,
  ShouldThrottle,
} from './types.js';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_TARGETS_PER_REQUEST = 8;
const DEFAULT_HISTORY_WINDOW = 32;
const DEFAULT_MIN_CONFIDENCE = 0.2;
const DEFAULT_EVENT_LIMIT = 128;
const DEFAULT_DISABLE_AFTER = 3;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_MAX_RESIDENT_ENTRIES = 1024;
const DEFAULT_MAX_KNOWN_TARGETS = 1024;
const DEFAULT_MAX_TRACKED_LOADS = 256;

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
  const now = config.now ?? clockNow;

  const targets = createTargetIndex(config.targets ?? [], config.maxKnownTargets ?? DEFAULT_MAX_KNOWN_TARGETS);
  const index = targets.index;
  const history: string[] = [];
  const ledger = createPrefetchLedger({
    now,
    eventLogLimit: Math.max(1, config.eventLogLimit ?? DEFAULT_EVENT_LIMIT),
    onEvent: config.onEvent,
  });
  const counters = ledger.counters;
  const resident = createResidentStore({
    budgetBytes: config.residentBudgetBytes ?? Number.POSITIVE_INFINITY,
    maxEntries: config.maxResidentEntries ?? DEFAULT_MAX_RESIDENT_ENTRIES,
  });
  const tuner = createSelfTuner({
    now,
    disableAfter: Math.max(1, config.tuning?.disableAfter ?? DEFAULT_DISABLE_AFTER),
    minSamples: Math.max(1, config.tuning?.minSamples ?? DEFAULT_MIN_SAMPLES),
    retryAfterMs: Math.max(0, config.tuning?.retryAfterMs ?? 0),
    maxTrackedLoads: config.tuning?.maxTrackedLoads ?? DEFAULT_MAX_TRACKED_LOADS,
  });
  const loads = createLoadRegistry({
    loader,
    now,
    onLoaded(rec, value) {
      counters.completed += 1;
      ledger.noteLoad(rec.loadMs);
      resident.set(rec.id, {
        value,
        bytes: rec.bytes,
        loadedAt: now(),
        loadMs: rec.loadMs,
        source: rec.speculative ? 'prefetch' : 'demand',
        claimed: false,
      });
      if (rec.speculative) tuner.noteSpeculativeLoad(rec.id, rec.loadMs);
      ledger.record({ id: rec.id, strategy: rec.strategy, outcome: 'loaded', durationMs: rec.loadMs });
    },
    onFailed(rec, aborted) {
      if (aborted) counters.cancelled += 1;
      else counters.failed += 1;
      ledger.record({
        id: rec.id,
        strategy: rec.strategy,
        outcome: aborted ? 'cancelled' : 'failed',
        durationMs: rec.loadMs,
      });
    },
  });

  let enabled = config.enabled !== false;

  function isPressure(): boolean {
    try {
      return shouldThrottle() === true;
    } catch {
      // A misbehaving pressure callback must never break inference.
      return false;
    }
  }

  /** Drop speculative work and the prefetched data nobody asked for. */
  function relievePressure(): void {
    loads.dropUnjoined();
    resident.releaseUnclaimed();
  }

  const decideAdmission = createAdmissionGate({
    ledger,
    maxConcurrent,
    isEnabled: () => enabled,
    isPressure,
    relievePressure,
    isKnown: (id) => index.has(id),
    isResident: (id) => resident.has(id),
    isLoading: (id) => loads.has(id),
    speculativeCount: () => loads.speculativeCount(),
  });

  function startSpeculative(target: PrefetchTarget, strategy: PrefetchReason, signal?: AbortSignal): LoadRecord {
    const rec = loads.start(target, { speculative: true, strategy, signal });
    ledger.noteConcurrency(loads.speculativeCount());
    return rec;
  }

  function evaluateTuner(): void {
    const action = tuner.evaluate(enabled);
    if (action === 'reenable') {
      enabled = true;
      return;
    }
    if (action === 'disable') {
      enabled = false;
      relievePressure();
      ledger.record({ id: '*', strategy: 'explicit', outcome: 'throttled', durationMs: 0, skipReason: 'disabled' });
    }
  }

  function markClaimed(id: string): void {
    // A claimed load was not waste.
    tuner.markClaimed(id);
    resident.markClaimed(id);
  }

  function pushHistory(id: string): void {
    history.push(id);
    while (history.length > historyWindow) history.shift();
  }

  function startPredictions(predictions: readonly PrefetchPrediction[]): PrefetchPrediction[] {
    const acted: PrefetchPrediction[] = [];
    for (const prediction of predictions) {
      if (acted.length >= maxTargetsPerRequest) break;
      // Predictions never teach the target index: a predicted target is either
      // already indexed or a 0-byte placeholder for an unknown id, and learning
      // the placeholder would evict real metadata and record a false footprint.
      const verdict = decideAdmission(prediction.target, prediction.strategy);
      if (verdict.admit) startSpeculative(prediction.target, prediction.strategy);
      if (verdict.admit || verdict.result === 'duplicate') acted.push(prediction);
    }
    return acted;
  }

  function autoPredict(targetId: string): PrefetchPrediction[] {
    // History + static graph only: no caller profile is available here.
    const predictions = mergePredictions(
      [predictFromGraph(targetId, config.graph, index), predictFromHistory(history, index)],
      minConfidence,
    );
    return predictions.length === 0 ? [] : startPredictions(predictions);
  }

  function demandLoad(target: PrefetchTarget, signal: AbortSignal | undefined): Promise<unknown> {
    return loads.start(target, { speculative: false, strategy: 'explicit', signal }).promise;
  }

  async function request(
    target: PrefetchTarget,
    options?: { signal?: AbortSignal },
  ): Promise<PrefetchRequestResult> {
    targets.remember(target);
    const startedAt = now();
    let hit = false;
    let value: unknown;
    let creditEntry: ResidentValue | undefined;

    const residentEntry = resident.get(target.id);
    const inFlightRecord = loads.get(target.id);

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
        creditEntry = resident.peek(target.id);
        markClaimed(target.id);
      } catch {
        // The prefetch was cancelled (e.g. under pressure) — fall back to a
        // fresh on-demand load so the caller is never left without data.
        hit = false;
        value = await demandLoad(target, options?.signal);
      }
    } else {
      value = await demandLoad(target, options?.signal);
    }

    const waitMs = Math.max(0, now() - startedAt);
    if (hit) {
      counters.hits += 1;
      if (creditEntry?.source === 'prefetch') counters.prefetchHits += 1;
    } else {
      counters.misses += 1;
    }
    ledger.noteWait(waitMs);
    // A demand load of the same data would have cost about `loadMs`; the
    // prefetch saved the caller whatever it did not have to wait for.
    if (creditEntry?.source === 'prefetch') tuner.creditAvoidedWait(creditEntry.loadMs, waitMs);

    pushHistory(target.id);
    evaluateTuner();

    // Predict what the workload will need NEXT and start it in the
    // background. The caller never waits for this.
    const predicted = autoPredict(target.id);
    return { hit, value, waitMs, predicted };
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
    const signal = options?.signal;
    if (signal?.aborted) return [];
    const acted = startPredictions(predictions);
    // A prediction can be invalidated: aborting the signal cancels the
    // speculative loads that were started for it.
    if (signal) {
      const started: LoadRecord[] = [];
      for (const prediction of acted) {
        const rec = loads.get(prediction.target.id);
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
    targets.remember(target);
    const strategy: PrefetchReason = options?.strategy ?? 'explicit';
    const verdict = decideAdmission(target, strategy);
    if (!verdict.admit) return Promise.resolve(verdict.result);
    const rec = startSpeculative(target, strategy, options?.signal);
    return rec.promise.then(
      () => 'loaded' as PrefetchOutcome,
      () => (rec.controller.signal.aborted ? 'cancelled' as PrefetchOutcome : 'failed' as PrefetchOutcome),
    );
  }

  function cancelAll(): void {
    loads.abortSpeculative();
    resident.releaseUnclaimed();
  }

  function cancel(targetId: string): void {
    const rec = loads.get(targetId);
    if (rec && rec.speculative) rec.controller.abort();
    const entry = resident.peek(targetId);
    if (entry && entry.source === 'prefetch' && !entry.claimed) resident.delete(targetId);
  }

  function stats(): PrefetchStats {
    return ledger.snapshot({
      inFlight: loads.size,
      residentBytes: resident.bytes(),
      selfTunedOff: tuner.selfTunedOff,
      selfTuneTrips: tuner.trips,
    });
  }

  return {
    request,
    requestById(id, options) {
      const target = index.get(id);
      // An unknown id has no footprint: loading it as a 0-byte placeholder would hide
      // the value from the resident byte budget. The caller must supply the target.
      if (!target) return Promise.reject(new Error(`unknown prefetch target: ${id} (use request(target))`));
      return request(target, options);
    },
    predict,
    prefetch,
    cancelAll,
    cancel,
    release: (targetId) => resident.delete(targetId),
    stats,
    hitRate: () => stats().hitRate,
    waitMs: () => stats().waitMs,
    events: () => ledger.events(),
    residentIds: () => resident.ids(),
    isEnabled: () => enabled,
    setEnabled(next: boolean) {
      enabled = next;
      if (!enabled) cancelAll();
    },
    whenIdle: () => loads.whenIdle(),
  };
}
