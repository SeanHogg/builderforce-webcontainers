/**
 * Phase 1 — per-request token stream state for `InferenceClient.generate()`.
 *
 * ONE object holds everything a generate request owns on the host side — the
 * token queue, the iterator's waiter, and the stats promise — so the client
 * keeps a single `Map<id, TokenStream>` and cleanup can never leave a queue or
 * waiter behind for a finished id.
 */

import type { GenerationStats, InferenceToken } from './types.js';

export interface TokenStream {
  /** A token from the worker. Dropped once the consumer has stopped iterating. */
  push(token: InferenceToken): void;
  /** The worker finished the request. */
  done(stats: GenerationStats): void;
  /** The request failed (worker error reply, worker crash, failed post). */
  fail(error: Error): void;
  /** Resolves with the final stats; rejects when the request fails. Never unhandled. */
  readonly stats: Promise<GenerationStats>;
  /**
   * The consumer-facing iterator. `onEarlyClose` runs when the consumer stops
   * iterating (break / return / throw) before the stream settled.
   */
  iterate(onEarlyClose: () => void): AsyncIterable<InferenceToken>;
}

export function createTokenStream(onSettled: () => void): TokenStream {
  const queue: InferenceToken[] = [];
  let notify: (() => void) | undefined;
  let settled = false;
  let detached = false;
  let error: Error | undefined;
  let resolveStats!: (stats: GenerationStats) => void;
  let rejectStats!: (error: Error) => void;
  const stats = new Promise<GenerationStats>((resolve, reject) => {
    resolveStats = resolve;
    rejectStats = reject;
  });
  stats.catch(() => {}); // The consumer may only observe the iterator; never leave this unhandled.

  const wake = () => {
    const n = notify;
    notify = undefined;
    n?.();
  };
  const settle = () => {
    settled = true;
    onSettled();
    wake();
  };

  return {
    push(token) {
      if (settled || detached) return;
      queue.push(token);
      wake();
    },
    done(s) {
      if (settled) return;
      resolveStats(s);
      settle();
    },
    fail(e) {
      if (settled) return;
      error = e;
      rejectStats(e);
      settle();
    },
    stats,
    iterate(onEarlyClose) {
      return (async function* (): AsyncIterable<InferenceToken> {
        try {
          for (;;) {
            while (queue.length) yield queue.shift() as InferenceToken;
            if (error) throw error;
            if (settled) return;
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        } finally {
          if (!settled && !detached) {
            detached = true;
            queue.length = 0;
            onEarlyClose();
          }
        }
      })();
    },
  };
}
