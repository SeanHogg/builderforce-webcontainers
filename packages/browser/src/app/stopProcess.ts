/**
 * Stop a service's process: ask (`SIGTERM`), then insist (`SIGKILL`) after
 * `timeoutMs`. Resolves with the exit code, or undefined when even `SIGKILL`
 * got no exit within another `timeoutMs`.
 */
import type { ServiceHandle } from '@seanhogg/builderforce-webcontainers-core/app';

export async function stopProcess(handle: Pick<ServiceHandle, 'kill' | 'wait'>, timeoutMs: number): Promise<number | undefined> {
  handle.kill('SIGTERM');
  const graceful = await exitWithin(handle, timeoutMs);
  if (graceful !== undefined) return graceful;
  handle.kill('SIGKILL');
  return exitWithin(handle, timeoutMs);
}

/**
 * Read a process's output to its end and drop it. Cancelling the stream instead
 * would leave the runtime closing an already-cancelled stream when the process exits.
 */
export function discardOutput(output: ReadableStream<string>): void {
  void (async () => {
    const reader = output.getReader();
    try {
      while (!(await reader.read()).done);
    } catch {
      // the process went away; nothing to read
    }
  })();
}

/** The exit code, or undefined when the process has not exited within `ms`. */
export function exitWithin(handle: Pick<ServiceHandle, 'wait'>, ms: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([handle.wait(), timeout]).finally(() => clearTimeout(timer));
}
