/**
 * Phase 4 — the prefetcher's in-flight load registry.
 *
 * Starts loads, tracks them until they settle, and reports completion to the
 * hooks the prefetcher injects. At most one load per target id is in flight.
 *
 * An abort signal that is ALREADY aborted when a load is started never reaches
 * the loader: the load settles as cancelled immediately.
 */

import type { PrefetchLoader, PrefetchReason, PrefetchTarget } from './types.js';

export interface LoadRecord {
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
  completed: boolean;
  /** Wall-clock ms the load took. */
  loadMs: number;
  startedAt: number;
}

export interface StartLoadOptions {
  speculative: boolean;
  strategy: PrefetchReason;
  signal?: AbortSignal;
}

export interface LoadRegistryOptions {
  loader: PrefetchLoader;
  now: () => number;
  onLoaded(rec: LoadRecord, value: unknown): void;
  /** `aborted` is true when the load was cancelled rather than failing. */
  onFailed(rec: LoadRecord, aborted: boolean): void;
}

export interface LoadRegistry {
  get(id: string): LoadRecord | undefined;
  has(id: string): boolean;
  readonly size: number;
  start(target: PrefetchTarget, options: StartLoadOptions): LoadRecord;
  /** In-flight speculative loads. */
  speculativeCount(): number;
  /** Abort speculative loads nobody joined. Returns how many were aborted. */
  dropUnjoined(): number;
  /** Abort every in-flight speculative load. */
  abortSpeculative(): void;
  /** Resolve once nothing is in flight. */
  whenIdle(): Promise<void>;
}

/** The error a load settles with when its signal was already aborted. */
export function abortErrorOf(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  if (typeof DOMException === 'function') return new DOMException('aborted', 'AbortError');
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function createLoadRegistry(options: LoadRegistryOptions): LoadRegistry {
  const inFlight = new Map<string, LoadRecord>();

  function settle(rec: LoadRecord): void {
    rec.completed = true;
    rec.loadMs = Math.max(0, options.now() - rec.startedAt);
    if (inFlight.get(rec.id) === rec) inFlight.delete(rec.id);
  }

  function start(target: PrefetchTarget, startOptions: StartLoadOptions): LoadRecord {
    const controller = new AbortController();
    const startedAt = options.now();
    const signal = startOptions.signal;
    const forward = () => controller.abort();
    let promise: Promise<unknown>;
    if (signal?.aborted) {
      // Check FIRST: an aborted-before-call load must never run the loader.
      controller.abort();
      promise = Promise.reject(abortErrorOf(signal));
    } else {
      signal?.addEventListener('abort', forward, { once: true });
      promise = (async () => options.loader(target, controller.signal))();
    }
    const rec: LoadRecord = {
      id: target.id,
      controller,
      promise,
      bytes: target.bytes,
      strategy: startOptions.strategy,
      speculative: startOptions.speculative,
      joined: false,
      completed: false,
      loadMs: 0,
      startedAt,
    };
    inFlight.set(target.id, rec);
    promise.then(
      (value) => {
        signal?.removeEventListener('abort', forward);
        settle(rec);
        options.onLoaded(rec, value);
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', forward);
        settle(rec);
        options.onFailed(rec, rec.controller.signal.aborted || isAbortError(error));
      },
    );
    return rec;
  }

  return {
    get: (id) => inFlight.get(id),
    has: (id) => inFlight.has(id),
    get size() {
      return inFlight.size;
    },
    start,
    speculativeCount() {
      let count = 0;
      for (const rec of inFlight.values()) if (rec.speculative) count += 1;
      return count;
    },
    dropUnjoined() {
      let dropped = 0;
      for (const rec of [...inFlight.values()]) {
        if (!rec.speculative || rec.joined) continue;
        rec.controller.abort();
        dropped += 1;
      }
      return dropped;
    },
    abortSpeculative() {
      for (const rec of [...inFlight.values()]) {
        if (rec.speculative) rec.controller.abort();
      }
    },
    async whenIdle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()].map((rec) => rec.promise));
      }
    },
  };
}
