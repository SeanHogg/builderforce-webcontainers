/**
 * One Node process: event loop + process object + builtins + module system,
 * wired to a program's IO and the system's ports. `startNode` evaluates the
 * entry and resolves `exit` with the code once the process exits — by
 * `process.exit()`, an uncaught exception, being killed, or the loop going idle.
 */
import type { ByteChannel, ProgramIO, System, ThreadInfo } from '../system/types.js';
import type { IpcEndpoint } from '../system/ipc.js';
import { signalExitCode } from '../system/signals.js';
import { attachProcessChannel } from './ipc.js';
import { threadErrorEnvelope } from './workerThreads.js';
import { Buffer } from './buffer.js';
import { createBuiltins } from './builtins.js';
import { createModuleSystem, type ModuleSystem } from './loader.js';
import { EventLoop } from './loop.js';
import { createConsole, createProcess, ProcessExit, type NodeProcess } from './process.js';
import { esmReady } from './esm.js';
import { inspect } from './inspect.js';
import { installGlobalObject } from './globalObject.js';

export interface NodeOptions {
  system: System;
  io: ProgramIO;
  cwd: string;
  env: Record<string, string>;
  /** `process.argv` from index 1: the script path, then its arguments. */
  argv: string[];
  /**
   * Also install `process`, `Buffer`, `global`, timers and `fetch` on
   * `globalThis` — for a dedicated worker, where code reaching for globals
   * directly (`globalThis.process`) must find them. Off when several runtimes
   * share one realm.
   */
  installGlobals?: boolean;
  /** The channel to the parent: `process.send` in a forked child, `parentPort` in a worker thread. */
  ipc?: IpcEndpoint;
  /** Set when this process is a worker thread. */
  thread?: ThreadInfo;
}

export interface NodeInstance {
  readonly process: NodeProcess;
  readonly modules: ModuleSystem;
  /** Settles with the exit code. */
  readonly exit: Promise<number>;
  /** Run code in the process (the entry, `-e`, a REPL line). Errors become uncaught exceptions. */
  run(fn: () => unknown): void;
  /** Deliver a signal: `SIGINT` runs listeners if any, otherwise exits 130. */
  kill(signal?: string): void;
  /** An error the host caught outside the loop (a worker's unhandledrejection). */
  reportUncaught(error: unknown): void;
  /** Keep the process alive until the returned function is called. */
  hold(): () => void;
}

export async function startNode(options: NodeOptions): Promise<NodeInstance> {
  await esmReady;
  const { system } = options;
  // Once the process has finished it prints nothing — a host promise settling late
  // must not write past the exit the parent already saw.
  const io: ProgramIO = {
    ...options.io,
    stdout: (chunk) => finished || options.io.stdout(chunk),
    stderr: (chunk) => finished || options.io.stderr(chunk),
  };
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));
  let finished = false;
  const servers = new Set<{ close(): void }>();
  /** Raw TCP connections this process holds an end of (dialled, or accepted by its servers). */
  const connections = new Set<ByteChannel>();
  const track = (channel: ByteChannel) => {
    connections.add(channel);
    channel.onClose(() => connections.delete(channel));
    return channel;
  };

  // Servers and connections die with the process: wrap listen and connect so exit can close what is left open.
  const processSystem: System = {
    ...system,
    async connect(port) {
      const channel = await system.connect(port);
      if (channel && finished) channel.close();
      return channel && !finished ? track(channel) : undefined;
    },
    listen(port, handler, upgrade, connection) {
      const registration = system.listen(port, handler, upgrade, connection && ((socket) => connection(track(socket))));
      const tracked = {
        port: registration.port,
        // The host's answer (a process Worker's port table) passes through: a refusal reaches the server.
        ready: registration.ready,
        close() {
          servers.delete(tracked);
          registration.close();
        },
      };
      // Refused: nothing left to close at exit.
      registration.ready?.catch(() => servers.delete(tracked));
      servers.add(tracked);
      return tracked;
    },
  };

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    loop.stop();
    for (const server of [...servers]) server.close();
    for (const channel of [...connections]) channel.close();
    connections.clear();
    resolveExit(code);
  };

  const uncaught = (error: unknown) => {
    if (error instanceof ProcessExit || finished) return;
    if (proc.listenerCount('uncaughtException')) {
      try {
        proc.emit('uncaughtException', error, 'uncaughtException');
        return;
      } catch (nested) {
        error = nested;
      }
    }
    // A worker thread's fatal error is the parent's 'error' event, not output.
    if (options.thread && options.ipc?.connected) options.ipc.send(threadErrorEnvelope(error));
    else {
      const text = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : `Uncaught ${inspect(error)}`;
      io.stderr(`${text}\n\nNode.js v${proc.versions.node}\n`);
    }
    exitQuietly(proc.exitCode && proc.exitCode !== 0 ? proc.exitCode : 1);
  };

  const exitQuietly = (code?: number) => {
    try {
      proc.exit(code);
    } catch (error) {
      if (!(error instanceof ProcessExit)) throw error;
    }
  };

  const loop = new EventLoop({
    onIdle() {
      if (finished) return;
      try {
        proc.emit('beforeExit', Number(proc.exitCode ?? 0));
      } catch (error) {
        uncaught(error);
      }
      if (loop.alive) return; // a beforeExit listener scheduled more work
      exitQuietly();
    },
    onError: uncaught,
  });

  const proc = createProcess({
    argv: ['/usr/local/bin/node', ...options.argv],
    env: options.env,
    cwd: options.cwd,
    fs: system.fs,
    io,
    loop,
    onExit: finish,
  });
  if (options.ipc && !options.thread) attachProcessChannel(proc, options.ipc, loop);
  const console = createConsole(proc);
  const builtins = createBuiltins({ fs: system.fs, process: proc, loop, system: processSystem, io, console, thread: options.thread, ipc: options.ipc });

  const globals: Record<string, unknown> = {
    process: proc,
    Buffer,
    console,
    setTimeout: loop.setTimeout,
    setInterval: loop.setInterval,
    setImmediate: loop.setImmediate,
    clearTimeout: loop.clearTimeout,
    clearInterval: loop.clearInterval,
    clearImmediate: loop.clearImmediate,
    fetch: builtins.fetch,
  };
  const scope = installGlobalObject(globals, !!options.installGlobals);

  const modules = createModuleSystem({ fs: system.fs, isBuiltin: builtins.isBuiltin, builtin: builtins.get, globals, scope });
  (modules.Module as unknown as { builtinModules: string[] }).builtinModules = builtins.names;
  Object.defineProperty(proc, 'mainModule', { get: () => modules.main, configurable: true });

  const run = (fn: () => unknown) => {
    if (finished) return;
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(uncaught).finally(() => loop.scheduleCheck());
    } catch (error) {
      uncaught(error);
    }
    loop.scheduleCheck();
  };

  return {
    process: proc,
    modules,
    exit,
    run,
    kill(signal = 'SIGTERM') {
      if (finished) return;
      if (signal !== 'SIGKILL' && proc.listenerCount(signal)) {
        loop._run(() => proc.emit(signal, signal));
        return;
      }
      finish(signalExitCode(signal));
    },
    reportUncaught: uncaught,
    hold: () => loop.hold(),
  };
}
