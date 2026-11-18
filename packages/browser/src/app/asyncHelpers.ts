/**
 * The few async primitives the application runtime needs: one race helper for
 * every "wait, but no longer than / not after abort" case (timeouts, optional
 * exits, cancellable waits, sleeps), and the one way an unknown error becomes a
 * message.
 */

/** A thrown value as one line of text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WithinOptions<U> {
  /** Settle after this long with `onTimeout()` (default: reject "Timed out."). */
  ms?: number;
  onTimeout?: () => U;
  /** Settle when this aborts with `onAbort()` (default: reject "Cancelled."). */
  signal?: AbortSignal;
  onAbort?: () => U;
}

const NEVER = new Promise<never>(() => undefined);

/**
 * `promise`, unless `ms` passes or `signal` aborts first — then whatever
 * `onTimeout` / `onAbort` return (or throw). The timer and the abort listener
 * are released as soon as it settles, so nothing outlives the wait.
 *
 *   within(p, { ms, onTimeout: () => { throw new Error('slow') } })   a timeout
 *   within(proc.wait(), { ms, onTimeout: () => undefined })           an optional result
 *   within(p, { signal })                                             cancellable
 *   within(never(), { ms, onTimeout: () => undefined, signal, onAbort: () => undefined })   a sleep
 */
export function within<T, U = never>(promise: Promise<T>, options: WithinOptions<U>): Promise<T | U> {
  const { ms, signal } = options;
  if (signal?.aborted) return Promise.resolve().then(() => (options.onAbort ? options.onAbort() : cancelled()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<U>((resolve, reject) => {
    const settleWith = (fallback: (() => U) | undefined, error: () => never) => {
      try {
        resolve(fallback ? fallback() : error());
      } catch (thrown) {
        reject(thrown);
      }
    };
    if (ms !== undefined) timer = setTimeout(() => settleWith(options.onTimeout, timedOut), ms);
    if (signal) {
      onAbort = () => settleWith(options.onAbort, cancelled);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([promise, cut]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

/** A promise that never settles (the body of a sleep). */
export const never = (): Promise<never> => NEVER;

/** Resolves after `ms`, or as soon as `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => within(never(), { ms, onTimeout: () => undefined, signal, onAbort: () => undefined });

function timedOut(): never {
  throw new Error('Timed out.');
}

function cancelled(): never {
  throw new Error('Cancelled.');
}
