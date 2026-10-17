/**
 * Running one program in-process: its stdin queue, TTY line discipline,
 * output listeners and kill signal, packaged as a {@link ChildHandle}. The core
 * kernel uses it for every process; the browser worker uses it for the one
 * program it hosts. Also {@link RuntimeProcess}, the stream-based handle the
 * public `run()` returns.
 */
import type { ChildHandle, Program, ProgramIO, ProcessOptions, StdioChunk, System } from './types.js';
import { InputQueue, LineDiscipline, textChunks, toTerminal } from './terminal.js';
import type { IpcEndpoint } from './ipc.js';

let nextPid = 1000;

export function allocatePid(): number {
  return nextPid++;
}

export interface RunProgramOptions extends ProcessOptions {
  program: Program;
  args: string[];
  system: System;
  cwd: string;
  env: Record<string, string>;
  pid?: number;
  /** The child's end of its message channel to the parent (`ipc`); closed when the program exits. */
  channel?: IpcEndpoint;
}

export function runProgram(options: RunProgramOptions): ChildHandle {
  const pid = options.pid ?? allocatePid();
  const stdin = new InputQueue<StdioChunk>();
  const stdoutListeners = new Set<(chunk: StdioChunk) => void>();
  const stderrListeners = new Set<(chunk: StdioChunk) => void>();
  const resizeListeners = new Set<(cols: number, rows: number) => void>();
  const controller = new AbortController();
  // A dead process prints nothing: a straggling callback that writes after exit is dropped.
  // Chunks pass through as written: bytes stay bytes, so a binary protocol over a child's pipes survives.
  const emitOut = (chunk: StdioChunk) => settled || stdoutListeners.forEach((l) => l(chunk));
  const emitErr = (chunk: StdioChunk) => settled || stderrListeners.forEach((l) => l(chunk));
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
    stdout: emitOut,
    stderr: emitErr,
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

  // Children die with their parent unless `detached`: an orphan here would hold its
  // ports and timers with nothing left that can reach it to stop it.
  const children = new Set<ChildHandle>();
  const system: System = {
    ...options.system,
    spawn(command, args, spawnOptions) {
      const child = options.system.spawn(command, args, spawnOptions);
      if (!spawnOptions?.detached) {
        children.add(child);
        void child.exit.then(() => children.delete(child));
      }
      return child;
    },
  };
  const settle = (resolve: (code: number) => void, code: number) => {
    options.channel?.disconnect();
    settled = true;
    for (const child of children) child.kill('SIGTERM');
    resolve(code);
  };

  const exit = new Promise<number>((resolve) => {
    forceExit = (code) => settle(resolve, code);
    queueMicrotask(async () => {
      let code: number;
      try {
        code = await options.program({
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          io,
          system,
          signal: controller.signal,
          ipc: options.channel,
          thread: options.thread,
        });
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        code = 1;
      }
      settle(resolve, code);
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
      if (discipline) discipline.input(typeof data === 'string' ? data : new TextDecoder().decode(data));
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

/** A running process as a host page sees it: streams for xterm.js or a log, and its exit code. */
export interface RuntimeProcess {
  readonly pid: number;
  /** stdout and stderr, interleaved as written (`\r\n` line endings when attached to a terminal). */
  readonly combinedOutput: ReadableStream<string>;
  /** Keystrokes or piped input; closing it is end-of-file. */
  readonly stdin: WritableStream<string>;
  /** Resolves with the exit code (128 + signal number when killed). */
  wait(): Promise<number>;
  /** Default `SIGTERM`; `SIGKILL` cannot be caught. */
  kill(signal?: string): void;
  /** Resize the attached terminal. A no-op for a process started without one. */
  resizeTerminal(cols: number, rows: number): void;
}

/** `run(command, args?, options?)` and `run(command, options)` — the same call either way. */
export function runArguments(args: string[] | ProcessOptions = [], options: ProcessOptions = {}): [string[], ProcessOptions] {
  return Array.isArray(args) ? [args, options] : [[], args];
}

export function toRuntimeProcess(child: ChildHandle, terminal: boolean): RuntimeProcess {
  const combinedOutput = new ReadableStream<string>({
    start(controller) {
      let open = true;
      const push = (text: string | null) => text !== null && open && controller.enqueue(terminal ? toTerminal(text) : text);
      // One decoder per stream, so a character split across writes on one is not garbled by the other.
      child.onStdout(textChunks(push));
      child.onStderr(textChunks(push));
      void child.exit.then(() => {
        open = false;
        controller.close();
      });
    },
  });
  const stdin = new WritableStream<string>({
    write: (chunk) => child.write(chunk),
    close: () => child.closeStdin(),
  });
  return {
    pid: child.pid,
    combinedOutput,
    stdin,
    wait: () => child.exit,
    kill: (signal) => child.kill(signal),
    resizeTerminal: (cols, rows) => child.resize?.(cols, rows),
  };
}
