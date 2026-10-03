/**
 * One Node process: event loop + process object + builtins + module system,
 * wired to a program's IO and the system's ports. `startNode` evaluates the
 * entry and resolves `exit` with the code once the process exits — by
 * `process.exit()`, an uncaught exception, being killed, or the loop going idle.
 */
import type { ProgramIO, System } from '../system/types.js';
import { Buffer } from './buffer.js';
import { createBuiltins } from './builtins.js';
import { createModuleSystem, type ModuleSystem } from './loader.js';
import { EventLoop } from './loop.js';
import { createConsole, createProcess, ProcessExit, type NodeProcess } from './process.js';
import { esmReady } from './esm.js';
import { inspect } from './inspect.js';

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

const SIGNAL_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGKILL: 137, SIGHUP: 129 };

export async function startNode(options: NodeOptions): Promise<NodeInstance> {
  await esmReady;
  const { system, io } = options;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));
  let finished = false;
  const servers = new Set<{ close(): void }>();

  // Servers die with the process: wrap listen so exit can close what is left open.
  const processSystem: System = {
    ...system,
    listen(port, handler) {
      const registration = system.listen(port, handler);
      const tracked = {
        port: registration.port,
        close() {
          servers.delete(tracked);
          registration.close();
        },
      };
      servers.add(tracked);
      return tracked;
    },
  };

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    loop.stop();
    for (const server of [...servers]) server.close();
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
    const text = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : `Uncaught ${inspect(error)}`;
    io.stderr(`${text}\n\nNode.js v${proc.versions.node}\n`);
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
  const console = createConsole(proc);
  const builtins = createBuiltins({ fs: system.fs, process: proc, loop, system: processSystem, io, console });

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
  if (options.installGlobals) {
    Object.assign(globalThis, globals, { global: globalThis });
    globals.global = globalThis;
  } else {
    // A per-process view of the global object: reads fall through to the real
    // one, Node's own names resolve to this process's.
    globals.global = Object.assign(Object.create(globalThis), globals);
  }
  globals.globalThis = globals.global;

  const modules = createModuleSystem({ fs: system.fs, isBuiltin: builtins.isBuiltin, builtin: builtins.get, globals });
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
      finish(SIGNAL_CODES[signal] ?? 1);
    },
    reportUncaught: uncaught,
    hold: () => loop.hold(),
  };
}
