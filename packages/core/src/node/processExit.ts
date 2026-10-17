/**
 * `process.exit()` unwinds user code by throwing {@link ProcessExit}. Callbacks a
 * builtin queues into user code go through {@link queueCallback}, so an exit inside
 * one ends there instead of escaping to whatever host runs the microtask.
 */

/** Thrown by `process.exit()` to unwind user code; the runtime catches it. */
export class ProcessExit {
  constructor(readonly code: number) {}
}

/** `queueMicrotask` for a builtin's callback into user code (a stream tick, an fs callback). */
export function queueCallback(fn: () => void): void {
  queueMicrotask(() => {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof ProcessExit)) throw error;
    }
  });
}
