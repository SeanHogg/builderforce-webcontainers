/**
 * The `fs` module: the sync API (sync.ts) plus callback, promise and stream
 * forms derived from it, and `watch` over the VFS's change events.
 *
 * Async forms complete on a microtask. That is enough to keep ordering
 * Node-like (callbacks never run synchronously) and, because microtasks always
 * drain before the runtime's exit check, a chain of fs callbacks can never be
 * cut short by the process exiting.
 */
import { EventEmitterBase } from '../events.js';
import { createSyncFs, type FsContext, type SyncFs } from './sync.js';
import { createFsStreams } from './streams.js';
import { Dirent, Stats, constants } from './stats.js';
import { normalizePath } from '../../paths.js';
import { queueCallback } from '../processExit.js';
import type { StdinRead } from './stdinFd.js';

export interface FsModuleContext extends FsContext {
  /** Keep the process alive (a watcher is open); call the result to let go. */
  hold(): () => void;
  /** fd 0 for `fs.read`: this process's stdin (stdinFd.ts). */
  readStdin?: StdinRead;
}

type Fn = (...args: any[]) => any;


function lastCallback(args: unknown[]): Fn | undefined {
  return typeof args[args.length - 1] === 'function' ? (args.pop() as Fn) : undefined;
}

export function createFsModule(ctx: FsModuleContext): Record<string, any> {
  const sync = createSyncFs(ctx);

  const toCallback = (fn: Fn, shape: (result: any, args: any[]) => any[] = (r) => [r]) =>
    (...args: any[]) => {
      const cb = lastCallback(args);
      queueCallback(() => {
        let result: unknown;
        try {
          result = fn(...args);
        } catch (error) {
          cb?.(error);
          return;
        }
        cb?.(null, ...shape(result, args));
      });
    };

  const toPromise = (fn: Fn) => async (...args: any[]) => fn(...args);

  const { ReadStream, WriteStream } = createFsStreams(sync, ctx);

  class FSWatcher extends EventEmitterBase {
    private readonly release: () => void;
    private readonly unwatch: () => void;

    constructor(path: string, recursive: boolean, listener?: Fn) {
      super();
      const root = normalizePath(path);
      if (listener) this.on('change', listener);
      this.release = ctx.hold();
      this.unwatch = ctx.vfs.watch((change) => {
        const p = change.path;
        const inside = p === root || p.startsWith(root === '/' ? '/' : root + '/');
        if (!inside) return;
        const rel = p === root ? p.slice(p.lastIndexOf('/') + 1) : p.slice(root.length + (root === '/' ? 0 : 1));
        if (!recursive && rel.includes('/')) return;
        this.emit('change', change.type === 'write' && !change.created ? 'change' : 'rename', rel);
      });
    }

    close(): void {
      this.unwatch();
      this.release();
      this.emit('close');
    }

    ref(): this { return this; }
    unref(): this { return this; }
  }

  const watch = (path: string | URL, options?: Fn | string | { recursive?: boolean }, listener?: Fn) => {
    if (typeof options === 'function') [listener, options] = [options, undefined];
    const resolved = sync._resolve(path);
    if (!ctx.vfs.exists(resolved)) throw sync.statSync(resolved); // throws ENOENT
    return new FSWatcher(resolved, typeof options === 'object' && !!options?.recursive, listener);
  };

  const fileWatchers = new Map<string, { watcher: FSWatcher; listeners: Fn[] }>();
  const watchFile = (path: string, options: Fn | object, listener?: Fn) => {
    const fn = (typeof options === 'function' ? options : listener)!;
    const resolved = sync._resolve(path);
    let entry = fileWatchers.get(resolved);
    if (!entry) {
      const watcher = new FSWatcher(resolved, false);
      const current = { watcher, listeners: [] as Fn[] };
      let previous = sync.statSync(resolved, { throwIfNoEntry: false }) ?? new Stats(resolved, 'file', 0, 0);
      watcher.on('change', () => {
        const next = sync.statSync(resolved, { throwIfNoEntry: false }) ?? new Stats(resolved, 'file', 0, 0);
        for (const l of current.listeners) l(next, previous);
        previous = next;
      });
      fileWatchers.set(resolved, (entry = current));
    }
    entry.listeners.push(fn as Fn);
    return entry.watcher;
  };
  const unwatchFile = (path: string, listener?: Fn) => {
    const resolved = sync._resolve(path);
    const entry = fileWatchers.get(resolved);
    if (!entry) return;
    entry.listeners = listener ? entry.listeners.filter((l) => l !== listener) : [];
    if (!entry.listeners.length) {
      entry.watcher.close();
      fileWatchers.delete(resolved);
    }
  };

  const fs: Record<string, any> = { ...sync, constants, Stats, Dirent, ReadStream, WriteStream, FSWatcher, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
  delete fs._resolve;

  for (const name of Object.keys(sync)) {
    if (!name.endsWith('Sync')) continue;
    const base = name.slice(0, -4);
    const fn = (sync as unknown as Record<string, Fn>)[name]!;
    if (base === 'exists') fs.exists = (p: string, cb: Fn) => queueCallback(() => cb(sync.existsSync(p)));
    // (err, bytes, buffer|buffers), as Node's callbacks report them.
    else if (['read', 'write', 'readv', 'writev'].includes(base)) fs[base] = toCallback(fn, (n, args) => [n, args[1]]);
    else fs[base] = toCallback(fn);
  }
  const readFile = fs.read;
  // `fs.read(0, …)` reads stdin: it waits for input instead of failing with EBADF.
  fs.read = (fd: number, ...args: any[]) => {
    if (fd !== 0 || !ctx.readStdin) return readFile(fd, ...args);
    const cb = lastCallback(args);
    const options = args[0] && !ArrayBuffer.isView(args[0]) ? args[0] : typeof args[1] === 'object' && args[1] ? { buffer: args[0], ...args[1] } : { buffer: args[0], offset: args[1], length: args[2] };
    const buffer = options.buffer as ArrayBufferView;
    const offset = Number(options.offset ?? 0);
    const length = Number(options.length ?? buffer.byteLength - offset);
    void ctx.readStdin(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)).then(
      (count) => queueCallback(() => cb?.(null, count, buffer)),
      (error: unknown) => queueCallback(() => cb?.(error, 0, buffer)),
    );
  };
  fs.realpath.native = fs.realpath;
  fs.createReadStream = (path: string, options?: object | string) => new ReadStream(path, options as object);
  fs.createWriteStream = (path: string, options?: object | string) => new WriteStream(path, options as object);
  fs.watch = watch;
  fs.watchFile = watchFile;
  fs.unwatchFile = unwatchFile;

  const promises: Record<string, any> = { constants };
  for (const name of Object.keys(sync)) {
    if (!name.endsWith('Sync') || name === 'existsSync') continue;
    promises[name.slice(0, -4)] = toPromise((sync as unknown as Record<string, Fn>)[name]!);
  }
  promises.open = async (path: string, flags?: string) => fileHandle(sync, sync.openSync(path, flags), sync._resolve(path));
  promises.watch = (path: string, options?: { recursive?: boolean; signal?: AbortSignal }) => watchIterator(watch(path, options), options?.signal);
  fs.promises = promises;
  return fs;
}

function fileHandle(sync: SyncFs, fd: number, path: string) {
  return {
    fd,
    readFile: async (options?: string | { encoding?: string }) => sync.readFileSync(fd, options),
    writeFile: async (data: string | Uint8Array) => void sync.writeFileSync(path, data),
    appendFile: async (data: string | Uint8Array) => void sync.appendFileSync(path, data),
    read: async (buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => ({ bytesRead: sync.readSync(fd, buffer, offset, length, position), buffer }),
    write: async (data: string | Uint8Array, ...rest: any[]) => ({ bytesWritten: sync.writeSync(fd, data, ...rest), buffer: data }),
    writev: async (buffers: Uint8Array[], position?: number | null) => ({ bytesWritten: sync.writevSync(fd, buffers, position), buffers }),
    readv: async (buffers: Uint8Array[], position?: number | null) => ({ bytesRead: sync.readvSync(fd, buffers, position), buffers }),
    stat: async () => sync.fstatSync(fd),
    truncate: async (length?: number) => sync.ftruncateSync(fd, length),
    sync: async () => undefined,
    datasync: async () => undefined,
    chmod: async () => undefined,
    close: async () => sync.closeSync(fd),
  };
}

async function* watchIterator(watcher: { on(e: string, l: Fn): unknown; close(): void }, signal?: AbortSignal) {
  const queue: Array<{ eventType: string; filename: string }> = [];
  let wake: (() => void) | undefined;
  watcher.on('change', (eventType: string, filename: string) => {
    queue.push({ eventType, filename });
    wake?.();
  });
  signal?.addEventListener('abort', () => wake?.());
  try {
    while (!signal?.aborted) {
      if (queue.length) yield queue.shift()!;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    watcher.close();
  }
}

