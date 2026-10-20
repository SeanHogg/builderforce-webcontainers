/**
 * Signals as exit statuses (128 + the signal number, as a shell reports a
 * process a signal ended), and the broken-pipe error a write to a pipe whose
 * reader is gone raises — the in-memory stand-in for SIGPIPE.
 */

export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGPIPE: 141, SIGTERM: 143 };

/** The status of a pipeline stage stopped by writing to a closed pipe. */
export const SIGPIPE_STATUS = SIGNAL_EXIT_CODES.SIGPIPE!;

/** The exit status `signal` ends a process with (1 for a signal with no number here). */
export function signalExitCode(signal: string): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

/**
 * A write to a pipe nobody reads any more (`yes | head -1` once head exits).
 * `pipe` is the pipe that broke, so the pipeline stage writing into it — and only
 * that stage — turns it into SIGPIPE's status: a loop or group inside the stage
 * (`while true; do echo y; done | head -1`) must stop with it, as SIGPIPE ends the
 * whole subshell in a real shell, not swallow it and go round again.
 */
export class BrokenPipeError extends Error {
  readonly code = 'EPIPE';
  constructor(readonly pipe?: object) {
    super('EPIPE: broken pipe, write');
    this.name = 'BrokenPipeError';
  }
}

export function isBrokenPipe(error: unknown): boolean {
  return error instanceof BrokenPipeError || (error as { code?: unknown } | null)?.code === 'EPIPE';
}

/** Did writing into `pipe` (and not some other pipe) raise `error`? */
export function brokePipe(error: unknown, pipe: object): boolean {
  return error instanceof BrokenPipeError && error.pipe === pipe;
}
