/**
 * The checkpoint request a stop sends a `training` service before `SIGTERM`:
 * one line on the process's standard input. The Python worker takes it off
 * stdin (the program never reads it) and raises the flag
 * `bfwc.training.checkpoint_requested()` reports; the program saves and exits.
 */
import type { RuntimeProcess } from '@seanhogg/builderforce-webcontainers-core';

/** NUL-prefixed, so no text a person types is mistaken for it. */
export const CHECKPOINT_REQUEST = '\u0000bfwc:checkpoint\n';

/** Write the request to `process`'s stdin; a process whose stdin is gone is left to the stop that follows. */
export async function requestCheckpoint(process: Pick<RuntimeProcess, 'stdin'>): Promise<void> {
  try {
    const writer = process.stdin.getWriter();
    try {
      await writer.write(CHECKPOINT_REQUEST);
    } finally {
      writer.releaseLock();
    }
  } catch {
    // stdin closed or locked: SIGTERM follows.
  }
}
