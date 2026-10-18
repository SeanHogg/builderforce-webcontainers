/**
 * `node:wasi`: Node's `WASI` class, preview1, over the process's file system and
 * stdio. napi-rs `wasm32-wasip1` bindings (oxc-parser under Nuxt, and others) load
 * through it — single-threaded builds that need no shared memory, so no
 * cross-origin isolation.
 *
 * Imports this does not implement (sockets, `proc_raise`) answer ENOSYS instead of
 * failing instantiation: `wasiImport` holds every preview1 name. `poll_oneoff` reports every subscription ready at once: a
 * WASI call cannot block a process that runs on the event loop.
 */
import { CLOCK, ERRNO, Memory, attempt, guest, u64 } from './abi.js';
import { createWasiFiles, type WasiFs } from './files.js';

/** Every `wasi_snapshot_preview1` function: a module imports by name, so each must exist (ENOSYS when not implemented). */
const WASI_FUNCTIONS = [
  'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get', 'clock_res_get', 'clock_time_get', 'fd_advise', 'fd_allocate', 'fd_close', 'fd_datasync',
  'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_fdstat_set_rights', 'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times', 'fd_pread', 'fd_prestat_get',
  'fd_prestat_dir_name', 'fd_pwrite', 'fd_read', 'fd_readdir', 'fd_renumber', 'fd_seek', 'fd_sync', 'fd_tell', 'fd_write', 'path_create_directory', 'path_filestat_get',
  'path_filestat_set_times', 'path_link', 'path_open', 'path_readlink', 'path_remove_directory', 'path_rename', 'path_symlink', 'path_unlink_file', 'poll_oneoff',
  'proc_exit', 'proc_raise', 'sched_yield', 'random_get', 'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
] as const;

export interface WasiOptions {
  /** Only `preview1` exists here; `unstable` is rejected. */
  version?: 'preview1';
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

const knownClock = (id: number) => id === CLOCK.REALTIME || id === CLOCK.MONOTONIC || id === CLOCK.PROCESS_CPUTIME || id === CLOCK.THREAD_CPUTIME;

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
    private started = false;
    private readonly closeAll: () => void;

    constructor(options: WasiOptions = {}) {
      if (options.version !== undefined && options.version !== 'preview1') throw new TypeError(`WASI version "${options.version}" is not supported: only 'preview1' is`);
      this.returnOnExit = options.returnOnExit ?? true;
      const args = options.args ?? [];
      const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
      const memory = new Memory(() => {
        if (!this.memory) throw new Error('WASI: the instance has not been started or initialized');
        return this.memory;
      });
      const { closeAll, ...files } = createWasiFiles(deps.fs, deps, memory, options.preopens ?? {});
      this.closeAll = closeAll;
      const calls: Record<string, (...args: any[]) => number | void> = {
        ...files,
        args_get: (pointers: number, buffer: number) => attempt(() => memory.strings(args, pointers, buffer)),
        args_sizes_get: (count: number, size: number) => attempt(() => memory.sizes(args, count, size)),
        environ_get: (pointers: number, buffer: number) => attempt(() => memory.strings(env, pointers, buffer)),
        environ_sizes_get: (count: number, size: number) => attempt(() => memory.sizes(env, count, size)),
        clock_res_get: (id: number, result: number) => (knownClock(id) ? attempt(() => memory.u64(result, 1000n)) : ERRNO.INVAL),
        clock_time_get: (id: number, _precision: bigint, result: number) =>
          knownClock(id) ? attempt(() => memory.u64(result, id === CLOCK.REALTIME ? u64(Date.now()) * 1_000_000n : u64(performance.now() * 1_000_000))) : ERRNO.INVAL,
        random_get: (buffer: number, length: number) =>
          attempt(() => {
            // Filled outside the module's memory, which may be shared: getRandomValues rejects a view over it.
            for (let at = 0; at < length; at += 65536) {
              const chunk = new Uint8Array(Math.min(65536, length - at));
              crypto.getRandomValues(chunk);
              memory.bytes(buffer + at, chunk.length).set(chunk);
            }
          }),
        poll_oneoff: (subscriptions: number, events: number, count: number, ready: number) =>
          attempt(() =>
            guest(() => {
              const view = memory.view;
              for (let i = 0; i < count; i++) {
                const sub = subscriptions + i * 48;
                const event = events + i * 32;
                memory.bytes(event, 32).fill(0);
                view.setBigUint64(event, view.getBigUint64(sub, true), true); // userdata
                view.setUint8(event + 10, view.getUint8(sub + 8)); // the subscription's type
              }
              view.setUint32(ready, count, true);
            }),
          ),
        proc_exit: (code: number) => {
          throw new WasiExit(code);
        },
        sched_yield: () => ERRNO.SUCCESS,
      };
      this.wasiImport = Object.fromEntries(WASI_FUNCTIONS.map((name) => [name, calls[name] ?? (() => ERRNO.NOSYS)]));
    }

    getImportObject(): Record<string, unknown> {
      return { wasi_snapshot_preview1: this.wasiImport };
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
      } finally {
        this.closeAll();
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
