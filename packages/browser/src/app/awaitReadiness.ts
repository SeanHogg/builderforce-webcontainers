/**
 * Wait for services to be ready by following their readiness as it changes —
 * not a one-shot promise — so a service that restarts on the way (by policy, or
 * by `restart()`) is waited for, and only one that is down for good fails the wait.
 */
import { within } from './asyncHelpers.js';
import type { ServiceError } from './types.js';

/**
 * - `ready`: running (or a one-off that finished);
 * - `pending`: starting, restarting, or a restart is scheduled;
 * - `down`: not running and nothing will start it (never started, stopped, failed for good).
 */
export type Readiness = 'ready' | 'pending' | 'down';

export interface ReadinessSource {
  readonly id: string;
  readiness(): Readiness;
  /** Why it is down. */
  failure(): ServiceError;
  /** Called after every change that can move its readiness. */
  onChange(listener: () => void): () => void;
}

/** Why a service will not become ready. */
export class ServiceFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
    this.name = 'ServiceFailure';
  }
}

/**
 * Resolves when every source is `ready`; rejects with `ServiceFailure` as soon
 * as one is `down`. `signal` and `timeoutMs` bound the wait (rejecting
 * "Cancelled." / "Timed out.").
 */
export function untilReady(sources: readonly ReadinessSource[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  const unsubscribe: Array<() => void> = [];
  const waiting = new Promise<void>((resolve, reject) => {
    const check = () => {
      let pending = false;
      for (const source of sources) {
        const readiness = source.readiness();
        if (readiness === 'down') return reject(new ServiceFailure(source.failure()));
        if (readiness === 'pending') pending = true;
      }
      if (!pending) resolve();
    };
    for (const source of sources) unsubscribe.push(source.onChange(check));
    check();
  });
  return within(waiting, { signal: options.signal, ms: options.timeoutMs }).finally(() => unsubscribe.forEach((stop) => stop()));
}
