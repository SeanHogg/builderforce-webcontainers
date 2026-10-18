/**
 * `node:wasi`: Node's `WASI` class, preview1, over the process's file system and
 * stdio. napi-rs `wasm32-wasip1` bindings (oxc-parser under Nuxt, and others) load
 * through it — single-threaded builds that need no shared memory, so no
 * cross-origin isolation.
 *
 * Imports this does not implement (sockets, `proc_raise`) answer ENOSYS instead of
 * failing instantiation. `poll_oneoff` reports every subscription ready at once: a
 * WASI call cannot block a process that runs on the event loop.
 */
import { CLOCK, ERRNO, Memory } from './abi.js';
import { createWasiFiles, type WasiFs } from './files.js';

export interface WasiOptions {
  version?: 'preview1' | 'unstable';
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
}

export interface WasiDeps {
  fs: WasiFs;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  exit(code: number): void;
}

interface WasiInstance {
  exports: Record<string, unknown> & { memory?: WebAssembly.Memory; _start?: () => void; _initialize?: () => void };
}

/** `proc_exit`: unwinds the module's stack back to `start()`. */
class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`WASI exit ${code}`);
  }
}

export function createWasiModule(deps: WasiDeps): Record<string, unknown> {
  class WASI {
    readonly wasiImport: Record<string, (...args: any[]) => number | void>;
    private memory?: WebAssembly.Memory;
    private readonly returnOnExit: boolean;
    private readonly version: 'preview1' | 'unstable';
    private started = false;

    constructor(options: WasiOptions = {}) {
      this.version = options.version ?? 'preview1';
      this.returnOnExit = options.returnOnExit ?? true;
      const args = options.args ?? [];
      const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
      const memory = new Memory(() => {
        if (!this.memory) throw new Error('WASI: the instance has not been started or initialized');
        return this.memory;
      });
      const files = createWasiFiles(deps.fs, deps, memory, options.preopens ?? {});
      const calls: Record<string, (...args: any[]) => number | void> = {
        ...files,
        args_get: (pointers: number, buffer: number) => (memory.strings(args, pointers, buffer), ERRNO.SUCCESS),
        args_sizes_get: (count: number, size: number) => (memory.sizes(args, count, size), ERRNO.SUCCESS),
        environ_get: (pointers: number, buffer: number) => (memory.strings(env, pointers, buffer), ERRNO.SUCCESS),
        environ_sizes_get: (count: number, size: number) => (memory.sizes(env, count, size), ERRNO.SUCCESS),
        clock_res_get: (_id: number, result: number) => (memory.view.setBigUint64(result, 1000n, true), ERRNO.SUCCESS),
        clock_time_get: (id: number, _precision: bigint, result: number) => {
          const ns = id === CLOCK.REALTIME ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1_000_000));
          memory.view.setBigUint64(result, ns, true);
          return ERRNO.SUCCESS;
        },
        random_get: (buffer: number, length: number) => {
          for (let at = 0; at < length; at += 65536) crypto.getRandomValues(memory.bytes(buffer + at, Math.min(65536, length - at)));
          return ERRNO.SUCCESS;
        },
        poll_oneoff: (subscriptions: number, events: number, count: number, ready: number) => {
          const view = memory.view;
          for (let i = 0; i < count; i++) {
            const sub = subscriptions + i * 48;
            const event = events + i * 32;
            memory.bytes(event, 32).fill(0);
            view.setBigUint64(event, view.getBigUint64(sub, true), true); // userdata
            view.setUint8(event + 10, view.getUint8(sub + 8)); // the subscription's type
          }
          view.setUint32(ready, count, true);
          return ERRNO.SUCCESS;
        },
        proc_exit: (code: number) => {
          throw new WasiExit(code);
        },
        sched_yield: () => ERRNO.SUCCESS,
      };
      this.wasiImport = new Proxy(calls, { get: (target, name) => (typeof name === 'string' && name in target ? target[name] : () => ERRNO.NOSYS) });
    }

    getImportObject(): Record<string, unknown> {
      return { [this.version === 'unstable' ? 'wasi_unstable' : 'wasi_snapshot_preview1']: this.wasiImport };
    }

    /** Run a command module's `_start`; answers its exit code (or exits the process, without `returnOnExit`). */
    start(instance: WasiInstance): number | undefined {
      const { _start } = this.attach(instance);
      if (typeof _start !== 'function') throw new TypeError('instance.exports._start is not a function');
      try {
        _start();
        return 0;
      } catch (error) {
        if (!(error instanceof WasiExit)) throw error;
        if (this.returnOnExit) return error.code;
        deps.exit(error.code);
        return undefined;
      }
    }

    /** Set up a reactor module (`_initialize`, no `_start`). */
    initialize(instance: WasiInstance): void {
      const { _start, _initialize } = this.attach(instance);
      if (typeof _start === 'function') throw new TypeError('instance.exports._start must not be a function for initialize()');
      if (typeof _initialize === 'function') _initialize();
    }

    private attach(instance: WasiInstance): WasiInstance['exports'] {
      if (this.started) throw new Error('WASI instance has already started');
      this.started = true;
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('instance.exports.memory must be a WebAssembly.Memory');
      this.memory = memory;
      return instance.exports;
    }
  }
  return { WASI };
}
