/**
 * Running one program in-process: its stdin queue, TTY line discipline,
 * output listeners and kill signal, packaged as a {@link ChildHandle}. The core
 * kernel uses it for every process; the browser worker uses it for the one
 * program it hosts. Also the WebContainer-shaped wrapper (`output`/`input`
 * streams) that public `spawn` returns.
 */
import type { ChildHandle, Program, ProgramIO, SpawnOptions, System } from './types.js';
import { InputQueue, LineDiscipline, toTerminal } from './terminal.js';

let nextPid = 1000;

export function allocatePid(): number {
  return nextPid++;
}

export interface RunProgramOptions extends SpawnOptions {
  program: Program;
  args: string[];
  system: System;
  cwd: string;
  env: Record<string, string>;
  pid?: number;
}

/** Decode byte chunks without splitting multi-byte characters across writes. */
function textSink(emit: (text: string) => void): (chunk: string | Uint8Array) => void {
  const decoder = new TextDecoder();
  return (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text) emit(text);
  };
}

export function runProgram(options: RunProgramOptions): ChildHandle {
  const pid = options.pid ?? allocatePid();
  const stdin = new InputQueue();
  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const resizeListeners = new Set<(cols: number, rows: number) => void>();
  const controller = new AbortController();
  const emitOut = (text: string) => stdoutListeners.forEach((l) => l(text));
  const emitErr = (text: string) => stderrListeners.forEach((l) => l(text));
  let settled = false;
  let forceExit: (code: number) => void = () => undefined;

  const kill = (signal = 'SIGTERM') => {
    if (settled) return;
    if (!controller.signal.aborted) controller.abort(signal);
    else if (signal === 'SIGKILL') forceExit(137);
  };

  const size = options.terminal ? { ...options.terminal } : undefined;
  const discipline = size
    ? new LineDiscipline({ echo: emitOut, deliver: (chunk) => stdin.push(chunk), signal: (name) => kill(name) })
    : undefined;

  const io: ProgramIO = {
    stdout: textSink(emitOut),
    stderr: textSink(emitErr),
    onStdin: (listener) => stdin.subscribe(listener),
    terminal: size && discipline
      ? {
          get cols() {
            return size.cols;
          },
          get rows() {
            return size.rows;
          },
          onResize(listener) {
            resizeListeners.add(listener);
            return () => resizeListeners.delete(listener);
          },
          setRawMode(raw) {
            discipline.raw = raw;
          },
        }
      : undefined,
  };

  const exit = new Promise<number>((resolve) => {
    forceExit = (code) => {
      settled = true;
      resolve(code);
    };
    queueMicrotask(async () => {
      let code: number;
      try {
        code = await options.program({ args: options.args, cwd: options.cwd, env: options.env, io, system: options.system, signal: controller.signal });
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        code = 1;
      }
      settled = true;
      resolve(code);
    });
  });

  return {
    pid,
    onStdout(listener) {
      stdoutListeners.add(listener);
      return () => stdoutListeners.delete(listener);
    },
    onStderr(listener) {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    write(data) {
      if (discipline) discipline.input(data);
      else stdin.push(data);
    },
    closeStdin: () => stdin.push(null),
    kill,
    resize(cols, rows) {
      if (!size) return;
      size.cols = cols;
      size.rows = rows;
      resizeListeners.forEach((l) => l(cols, rows));
    },
    exit,
  };
}

/** The public process shape, deliberately the same as `@webcontainer/api`'s `WebContainerProcess`. */
export interface WebContainerProcess {
  /** stdout and stderr, interleaved as written (`\r\n` line endings when attached to a terminal). */
  readonly output: ReadableStream<string>;
  readonly input: WritableStream<string>;
  readonly exit: Promise<number>;
  kill(signal?: string): void;
  resize(dimensions: { cols: number; rows: number } | number, rows?: number): void;
}

export function toWebContainerProcess(child: ChildHandle, terminal: boolean): WebContainerProcess {
  const output = new ReadableStream<string>({
    start(controller) {
      const push = (chunk: string) => controller.enqueue(terminal ? toTerminal(chunk) : chunk);
      child.onStdout(push);
      child.onStderr(push);
      void child.exit.then(() => controller.close());
    },
  });
  const input = new WritableStream<string>({
    write: (chunk) => child.write(chunk),
    close: () => child.closeStdin(),
  });
  return {
    output,
    input,
    exit: child.exit,
    kill: (signal) => child.kill(signal),
    resize(dimensions, rows) {
      const size = typeof dimensions === 'number' ? { cols: dimensions, rows: rows ?? 24 } : dimensions;
      child.resize?.(size.cols, size.rows);
    },
  };
}
