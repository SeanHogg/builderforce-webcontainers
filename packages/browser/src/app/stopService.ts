/**
 * Ending a service's process: one attempt (`ServiceRun`) at running it, and the
 * ways that attempt ends from outside — a cooperative stop (`SIGTERM`, then
 * `SIGKILL` after a timeout) or abandoning it (`SIGKILL`, output dropped).
 */
import type { ServiceHandle } from '@seanhogg/builderforce-webcontainers-core/app';
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { within } from './asyncHelpers.js';
import type { AttributedProcesses } from './types.js';

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

/**
 * Ask (`SIGTERM`), then insist (`SIGKILL`) after `timeoutMs`. A service that
 * checkpoints (training) is first asked to save and exit, for up to `timeoutMs`.
 * Undefined when even `SIGKILL` got no exit within another `timeoutMs`.
 */
export async function stopProcess(handle: Pick<ServiceHandle, 'kill' | 'wait' | 'checkpoint'>, timeoutMs: number): Promise<number | undefined> {
  if (handle.checkpoint) {
    await within(handle.checkpoint().catch(() => undefined), { ms: timeoutMs, onTimeout: () => undefined });
    const saved = await exitWithin(handle, timeoutMs);
    if (saved !== undefined) return saved;
  }
  handle.kill('SIGTERM');
  const graceful = await exitWithin(handle, timeoutMs);
  if (graceful !== undefined) return graceful;
  handle.kill('SIGKILL');
  return exitWithin(handle, timeoutMs);
}

/**
 * End every process still attributed to `security` — what outlived the
 * service's own process (`detached` children, orphans): its service's, or with
 * `wholeApplication` every service's.
 */
export function endAttributed(processes: AttributedProcesses | undefined, security: SecurityContext, wholeApplication = false): void {
  processes?.killApplication(security.applicationId, wholeApplication ? undefined : security.serviceId);
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
