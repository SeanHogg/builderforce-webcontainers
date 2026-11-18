/**
 * Ending a service's process: one attempt (`ServiceRun`) at running it, and the
 * ways that attempt ends from outside — a cooperative stop (`SIGTERM`, then
 * `SIGKILL` after a timeout) or abandoning it (`SIGKILL`, output dropped).
 */
import type { ServiceHandle } from '@seanhogg/builderforce-webcontainers-core/app';
import { within } from './asyncHelpers.js';

/** One attempt at running a service's process. */
export interface ServiceRun {
  /** Aborted when the attempt ends: cancels its waits (dependencies, readiness). */
  readonly controller: AbortController;
  /** Set while the provider is starting the process. */
  handlePromise?: Promise<ServiceHandle>;
  handle?: ServiceHandle;
  readyAt?: number;
  exitCode?: number;
  /** A one-off (`exit-zero`) service exited 0. */
  completed?: boolean;
  /** A stop gave up waiting for the provider to start it: whoever gets the handle later abandons it. */
  abandoned?: boolean;
}

/** The exit code, or undefined when the process has not exited within `ms`. */
export const exitWithin = (handle: Pick<ServiceHandle, 'wait'>, ms: number): Promise<number | undefined> => within(handle.wait(), { ms, onTimeout: () => undefined });

/** Ask (`SIGTERM`), then insist (`SIGKILL`) after `timeoutMs`. Undefined when even `SIGKILL` got no exit within another `timeoutMs`. */
export async function stopProcess(handle: Pick<ServiceHandle, 'kill' | 'wait'>, timeoutMs: number): Promise<number | undefined> {
  handle.kill('SIGTERM');
  const graceful = await exitWithin(handle, timeoutMs);
  if (graceful !== undefined) return graceful;
  handle.kill('SIGKILL');
  return exitWithin(handle, timeoutMs);
}

/** Kill without waiting and drop its output; returns its exit, for the next launch to wait on. */
export function abandonProcess(handle: ServiceHandle): Promise<number> {
  handle.kill('SIGKILL');
  void handle.output.cancel().catch(() => undefined);
  return handle.wait();
}

/**
 * Stop a run from outside: wait (up to `timeoutMs`) for a process the provider
 * is still starting, then stop it cooperatively. Returns the process stopped
 * (its `wait()` is what the next launch waits on), or undefined when there was none.
 */
export async function stopRun(run: ServiceRun, timeoutMs: number): Promise<ServiceHandle | undefined> {
  run.controller.abort();
  let handle = run.handle;
  if (!handle && run.handlePromise) {
    handle = await within(run.handlePromise.catch(() => undefined), { ms: timeoutMs, onTimeout: () => undefined });
    if (!handle) {
      run.abandoned = true;
      return undefined;
    }
  }
  if (!handle) return undefined;
  if (run.exitCode === undefined) await stopProcess(handle, timeoutMs);
  return handle;
}
