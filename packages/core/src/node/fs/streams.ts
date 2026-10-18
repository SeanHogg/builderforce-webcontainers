/**
 * `fs.ReadStream` / `fs.WriteStream`. Both are callable without `new`, as Node's are:
 * graceful-fs (under webpack's cache and many CLIs) subclasses them the pre-class way,
 * `fs$WriteStream.apply(this, arguments)` on an object it made, and replaces `open`.
 */
import { Buffer } from '../buffer.js';
import { callable } from '../callable.js';
import { initReadable, Readable } from '../stream/readable.js';
import { initWritable, Writable } from '../stream/writable.js';
import { queueCallback } from '../processExit.js';
import type { FsContext, SyncFs } from './sync.js';

type Fn = (...args: any[]) => any;
type ReadOptions = { start?: number; end?: number; encoding?: string; highWaterMark?: number; fd?: number; flags?: string; mode?: number };
type WriteOptions = { flags?: string; encoding?: string; mode?: number };

const CHUNK = 64 * 1024;

const optionsOf = <T extends { encoding?: string }>(options: T | string | undefined): T => (typeof options === 'string' ? ({ encoding: options } as T) : options ?? ({} as T));

export interface FsStreams {
  ReadStream: new (path: string | URL, options?: ReadOptions | string) => Readable;
  WriteStream: new (path: string | URL, options?: WriteOptions | string) => Writable;
}

export function createFsStreams(sync: SyncFs, ctx: FsContext): FsStreams {
  class ReadStream extends Readable {
    declare bytesRead: number;
    declare path: string;
    declare fd: number | null;
    declare flags: string;
    declare mode: number;
    declare pending: boolean;
    declare data?: Uint8Array;
    declare offset: number;
    declare endAt: number;

    constructor(path: string | URL, options?: ReadOptions | string) {
      const opts = optionsOf(options);
      super({ highWaterMark: opts.highWaterMark ?? CHUNK, encoding: opts.encoding });
      startRead(this, path, opts);
    }

    /** Node's legacy hook; a subclass that replaces it opens the file itself. */
    open(): void {}

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

  function startRead(self: ReadStream, path: string | URL, opts: ReadOptions): void {
    self.bytesRead = 0;
    self.fd = null;
    self.pending = true;
    self.flags = opts.flags ?? 'r';
    self.mode = opts.mode ?? 0o666;
    self.path = opts.fd !== undefined ? '' : sync._resolve(path);
    self.offset = opts.start ?? 0;
    self.endAt = opts.end ?? Infinity;
    queueCallback(() => {
      try {
        self.data = sync.readFileSync(self.path) as Buffer;
        self.pending = false;
        if (self.open !== ReadStream.prototype.open) self.open();
        else {
          self.fd = -1;
          self.emit('open', self.fd);
          self.emit('ready');
        }
        self._pull();
      } catch (error) {
        self.destroy(error as Error);
      }
    });
  }

  class WriteStream extends Writable {
    declare bytesWritten: number;
    declare path: string;
    declare fd: number | null;
    declare flags: string;
    declare mode: number;
    declare pending: boolean;
    declare started: boolean;

    constructor(path: string | URL, options?: WriteOptions | string) {
      super({ decodeStrings: true });
      startWrite(this, path, optionsOf(options));
    }

    /** Node's legacy hook; a subclass that replaces it opens the file itself. */
    open(): void {}

    /** Create or truncate the file once, as opening it with `flags` would. */
    ensureFile(): void {
      if (this.started) return;
      this.started = true;
      if (!this.flags.startsWith('a') || !ctx.vfs.isFile(this.path)) sync.writeFileSync(this.path, '', { flag: this.flags.includes('x') ? 'wx' : 'w' });
    }

    override _write(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void {
      // A replaced `open` opens (and truncates) later: writes wait for it, as Node's do.
      if (this.fd === null && this.open !== WriteStream.prototype.open) {
        this.once('open', () => this._write(chunk, encoding, callback));
        return;
      }
      try {
        this.ensureFile();
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

  function startWrite(self: WriteStream, path: string | URL, opts: WriteOptions): void {
    self.bytesWritten = 0;
    self.fd = null;
    self.pending = false;
    self.started = false;
    self.flags = opts.flags ?? 'w';
    self.mode = opts.mode ?? 0o666;
    self.path = sync._resolve(path);
    queueCallback(() => {
      try {
        if (self.open !== WriteStream.prototype.open) {
          self.started = true; // the replacement opens (and truncates) the file
          self.open();
          return;
        }
        self.ensureFile();
        self.fd = -1;
        self.emit('open', self.fd);
        self.emit('ready');
      } catch (error) {
        self.destroy(error as Error);
      }
    });
  }

  return {
    ReadStream: callable(ReadStream, (self: ReadStream, path: string | URL, options?: ReadOptions | string) => {
      const opts = optionsOf(options);
      initReadable(self, { highWaterMark: opts.highWaterMark ?? CHUNK, encoding: opts.encoding });
      startRead(self, path, opts);
    }),
    WriteStream: callable(WriteStream, (self: WriteStream, path: string | URL, options?: WriteOptions | string) => {
      initWritable(self, { decodeStrings: true });
      startWrite(self, path, optionsOf(options));
    }),
  };
}
