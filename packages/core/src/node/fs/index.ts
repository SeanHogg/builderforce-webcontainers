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
import { Buffer } from '../buffer.js';
import { Readable } from '../stream/readable.js';
import { Writable } from '../stream/writable.js';
import { createSyncFs, type FsContext, type SyncFs } from './sync.js';
import { Dirent, Stats, constants } from './stats.js';
import { normalizePath } from '../../paths.js';

export interface FsModuleContext extends FsContext {
  /** Keep the process alive (a watcher is open); call the result to let go. */
  hold(): () => void;
}

type Fn = (...args: any[]) => any;

const CHUNK = 64 * 1024;

function lastCallback(args: unknown[]): Fn | undefined {
  return typeof args[args.length - 1] === 'function' ? (args.pop() as Fn) : undefined;
}

export function createFsModule(ctx: FsModuleContext): Record<string, any> {
  const sync = createSyncFs(ctx);

  const toCallback = (fn: Fn, shape: (result: any, args: any[]) => any[] = (r) => [r]) =>
    (...args: any[]) => {
      const cb = lastCallback(args);
      queueMicrotask(() => {
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

  class ReadStream extends Readable {
    bytesRead = 0;
    readonly path: string;
    fd: number | null = null;
    pending = true;
    private data?: Uint8Array;
    private offset: number;
    private readonly endAt: number;

    constructor(path: string | URL, options: { start?: number; end?: number; encoding?: string; highWaterMark?: number; fd?: number } | string = {}) {
      const opts = typeof options === 'string' ? { encoding: options } : options;
      super({ highWaterMark: opts.highWaterMark ?? CHUNK, encoding: opts.encoding });
      this.path = typeof options === 'object' && opts.fd !== undefined ? '' : sync._resolve(path);
      this.offset = opts.start ?? 0;
      this.endAt = opts.end ?? Infinity;
      queueMicrotask(() => {
        try {
          const contents = sync.readFileSync(this.path) as Buffer;
          this.data = contents;
          this.fd = -1;
          this.pending = false;
          this.emit('open', this.fd);
          this.emit('ready');
          this._pull();
        } catch (error) {
          this.destroy(error as Error);
        }
      });
    }

    override _read(): void {
      if (!this.data) {
        this._readableState.reading = false; // retried once the file is loaded
        return;
      }
      const end = Math.min(this.data.length, this.endAt + 1);
      if (this.offset >= end) {
        this.push(null);
        return;
      }
      const chunk = this.data.subarray(this.offset, Math.min(end, this.offset + this._readableState.highWaterMark));
      this.offset += chunk.length;
      this.bytesRead += chunk.length;
      this.push(Buffer.from(chunk));
    }

    close(callback?: Fn): void {
      this.destroy();
      if (callback) this.once('close', callback);
    }
  }

  class WriteStream extends Writable {
    bytesWritten = 0;
    readonly path: string;
    pending = false;
    private started = false;

    constructor(path: string | URL, private readonly options: { flags?: string; encoding?: string } | string = {}) {
      super({ decodeStrings: true });
      this.path = sync._resolve(path);
      queueMicrotask(() => {
        try {
          this.open();
          this.emit('open', -1);
          this.emit('ready');
        } catch (error) {
          this.destroy(error as Error);
        }
      });
    }

    private open(): void {
      if (this.started) return;
      this.started = true;
      const flags = typeof this.options === 'object' ? this.options.flags ?? 'w' : 'w';
      if (!flags.startsWith('a') || !ctx.vfs.isFile(this.path)) sync.writeFileSync(this.path, '', { flag: flags.includes('x') ? 'wx' : 'w' });
    }

    override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      try {
        this.open();
        sync.appendFileSync(this.path, chunk);
        this.bytesWritten += chunk.length;
        callback();
      } catch (error) {
        callback(error as Error);
      }
    }

    close(callback?: Fn): void {
      this.end();
      if (callback) this.once('close', callback);
    }
  }

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
    if (base === 'exists') fs.exists = (p: string, cb: Fn) => queueMicrotask(() => cb(sync.existsSync(p)));
    else if (base === 'read') fs.read = toCallback(fn, (n, args) => [n, args[1]]);
    else if (base === 'write') fs.write = toCallback(fn, (n, args) => [n, args[1]]);
    else fs[base] = toCallback(fn);
  }
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

