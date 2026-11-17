/**
 * Phase 4 — prefetcher counters and the bounded, explainable event log.
 *
 * One ledger per prefetcher. Every other prefetch module writes its counters
 * here instead of keeping its own, so `stats()` is a pure projection.
 */

import type { PrefetchEvent, PrefetchStats } from './types.js';

/** Mutable counters. Modules increment fields directly; `snapshot()` projects them. */
export interface PrefetchCounters {
  hits: number;
  misses: number;
  prefetchHits: number;
  attempts: number;
  completed: number;
  throttled: number;
  cancelled: number;
  failed: number;
  skipped: number;
  totalWaitMs: number;
  waitSamples: number;
  totalLoadMs: number;
  loadSamples: number;
  peakConcurrent: number;
}

/** Live values owned by other modules, folded into a stats snapshot. */
export interface PrefetchLiveState {
  inFlight: number;
  residentBytes: number;
  selfTunedOff: boolean;
  selfTuneTrips: number;
}

export interface PrefetchLedger {
  readonly counters: PrefetchCounters;
  /** Append an event (stamped with the clock) and forward it to `onEvent`. */
  record(event: Omit<PrefetchEvent, 'at'>): void;
  /** Bounded log, oldest first. */
  events(): readonly PrefetchEvent[];
  /** Record one caller wait sample. */
  noteWait(waitMs: number): void;
  /** Record one completed load's duration. */
  noteLoad(loadMs: number): void;
  /** Track the peak number of concurrent speculative loads. */
  noteConcurrency(count: number): void;
  snapshot(live: PrefetchLiveState): PrefetchStats;
}

export interface PrefetchLedgerOptions {
  now: () => number;
  eventLogLimit: number;
  onEvent?: (event: PrefetchEvent) => void;
}

export function createPrefetchLedger(options: PrefetchLedgerOptions): PrefetchLedger {
  const counters: PrefetchCounters = {
    hits: 0,
    misses: 0,
    prefetchHits: 0,
    attempts: 0,
    completed: 0,
    throttled: 0,
    cancelled: 0,
    failed: 0,
    skipped: 0,
    totalWaitMs: 0,
    waitSamples: 0,
    totalLoadMs: 0,
    loadSamples: 0,
    peakConcurrent: 0,
  };
  const log: PrefetchEvent[] = [];

  return {
    counters,
    record(event) {
      const full: PrefetchEvent = { ...event, at: options.now() };
      log.push(full);
      if (log.length > options.eventLogLimit) log.splice(0, log.length - options.eventLogLimit);
      options.onEvent?.(full);
    },
    events: () => log,
    noteWait(waitMs) {
      counters.totalWaitMs += waitMs;
      counters.waitSamples += 1;
    },
    noteLoad(loadMs) {
      counters.totalLoadMs += loadMs;
      counters.loadSamples += 1;
    },
    noteConcurrency(count) {
      if (count > counters.peakConcurrent) counters.peakConcurrent = count;
    },
    snapshot(live) {
      const total = counters.hits + counters.misses;
      return {
        hits: counters.hits,
        misses: counters.misses,
        prefetchHits: counters.prefetchHits,
        attempts: counters.attempts,
        completed: counters.completed,
        throttled: counters.throttled,
        cancelled: counters.cancelled,
        failed: counters.failed,
        skipped: counters.skipped,
        hitRate: total === 0 ? 0 : counters.hits / total,
        totalWaitMs: counters.totalWaitMs,
        waitMs: counters.waitSamples === 0 ? 0 : counters.totalWaitMs / counters.waitSamples,
        avgLoadMs: counters.loadSamples === 0 ? 0 : counters.totalLoadMs / counters.loadSamples,
        inFlight: live.inFlight,
        maxConcurrent: counters.peakConcurrent,
        residentBytes: live.residentBytes,
        selfTunedOff: live.selfTunedOff,
        selfTuneTrips: live.selfTuneTrips,
      };
    },
  };
}
