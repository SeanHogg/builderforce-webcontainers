/**
 * Wiring a spawned child to a job's IO: its output as text, a reader that exited killing it with
 * SIGPIPE (and raising the break so the stage owning the pipe ends), its stdin from the job's queue
 * — or, on a terminal, the raw keystrokes straight through (the child has its own line discipline) —
 * and an abort killing it. The ONE implementation: the shell's external commands (`Shell.spawnExternal`)
 * and the dev-server tools run directly (`devHandoff.ts`) both use it.
 */
import type { ChildHandle } from '../system/types.js';
import { textChunks } from '../system/terminal.js';
import { isBrokenPipe } from '../system/signals.js';
import type { JobInput } from './exec.js';

export interface ChildOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Relay `child` until it exits and return its code. `rawTerminal`: the child is attached to a terminal, so
 * `input.setRawSink` (when the job has one) carries the keystrokes instead of the queue.
 */
export async function relayChild(child: ChildHandle, io: ChildOutput, input: JobInput, signal: AbortSignal, rawTerminal: boolean): Promise<number> {
  // The shell's own IO is text; a child's bytes are decoded as they enter it. Writing into
  // a pipe whose reader has exited kills the child with SIGPIPE (its timers stop with it),
  // then raises the break here, so the stage owning the pipe ends — a loop around it too.
  let brokenPipe: unknown;
  const relay = (write: (text: string) => void) => (text: string | null) => {
    if (text === null || brokenPipe !== undefined) return;
    try {
      write(text);
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
      brokenPipe = error;
      child.kill('SIGPIPE');
    }
  };
  child.onStdout(textChunks(relay(io.stdout)));
  child.onStderr(textChunks(relay(io.stderr)));
  let stop: (() => void) | undefined;
  if (rawTerminal && input.setRawSink) input.setRawSink((data) => child.write(data));
  else stop = input.queue.subscribe((chunk) => (chunk === null ? child.closeStdin() : child.write(chunk)));
  const onAbort = () => child.kill(typeof signal.reason === 'string' ? signal.reason : 'SIGINT');
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort);
  try {
    const code = await child.exit;
    if (brokenPipe !== undefined) throw brokenPipe;
    return code;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (rawTerminal && input.setRawSink) input.setRawSink(undefined);
    stop?.();
  }
}
