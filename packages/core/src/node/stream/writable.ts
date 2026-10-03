/**
 * stream.Writable — a write queue drained one `_write` at a time, `'drain'`
 * backpressure, `end` → `_final` → `'finish'`, cork/uncork. Its methods are also
 * mixed into Duplex (see duplex.ts), so they only touch `_writableState`.
 */
import { EventEmitterBase } from '../events.js';
import { Buffer } from '../buffer.js';
import { tick } from './readable.js';

type Callback = (error?: Error | null) => void;

export interface WritableOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  writableObjectMode?: boolean;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  write?(this: Writable, chunk: any, encoding: string, callback: Callback): void;
  writev?(this: Writable, chunks: Array<{ chunk: any; encoding: string }>, callback: Callback): void;
  final?(this: Writable, callback: Callback): void;
  destroy?(this: Writable, error: Error | null, callback: Callback): void;
  autoDestroy?: boolean;
  emitClose?: boolean;
}

export interface WritableState {
  objectMode: boolean;
  highWaterMark: number;
  decodeStrings: boolean;
  defaultEncoding: string;
  queue: Array<{ chunk: unknown; encoding: string; callback?: Callback }>;
  length: number;
  writing: boolean;
  corked: number;
  needDrain: boolean;
  ending: boolean;
  ended: boolean;
  finalCalled: boolean;
  finished: boolean;
  destroyed: boolean;
  closed: boolean;
  errored: Error | null;
  autoDestroy: boolean;
  emitClose: boolean;
}

export function initWritable(self: Writable, options: WritableOptions = {}): void {
  const objectMode = !!(options.objectMode || options.writableObjectMode);
  self._writableState = {
    objectMode,
    highWaterMark: options.highWaterMark ?? (objectMode ? 16 : 16 * 1024),
    decodeStrings: options.decodeStrings !== false,
    defaultEncoding: options.defaultEncoding ?? 'utf8',
    queue: [],
    length: 0,
    writing: false,
    corked: 0,
    needDrain: false,
    ending: false,
    ended: false,
    finalCalled: false,
    finished: false,
    destroyed: false,
    closed: false,
    errored: null,
    autoDestroy: options.autoDestroy ?? true,
    emitClose: options.emitClose ?? true,
  };
  if (typeof options.write === 'function') self._write = options.write;
  if (typeof options.writev === 'function') self._writev = options.writev;
  if (typeof options.final === 'function') self._final = options.final;
  if (typeof options.destroy === 'function') self._destroy = options.destroy;
}

export class Writable extends EventEmitterBase {
  declare _writableState: WritableState;
  _writev?(chunks: Array<{ chunk: any; encoding: string }>, callback: Callback): void;
  _final?(callback: Callback): void;

  constructor(options?: WritableOptions) {
    super();
    initWritable(this, options);
  }

  get writable(): boolean {
    const s = this._writableState;
    return !!s && !s.destroyed && !s.ending && !s.errored;
  }
  set writable(_value: boolean) {
    // legacy code assigns this; state is authoritative
  }
  get writableEnded(): boolean { return this._writableState.ending; }
  get writableFinished(): boolean { return this._writableState.finished; }
  get writableLength(): number { return this._writableState.length; }
  get writableHighWaterMark(): number { return this._writableState.highWaterMark; }
  get writableObjectMode(): boolean { return this._writableState.objectMode; }
  get writableCorked(): number { return this._writableState.corked; }
  get writableNeedDrain(): boolean { return this._writableState.needDrain; }
  get destroyed(): boolean { return this._writableState.destroyed; }
  set destroyed(value: boolean) { this._writableState.destroyed = value; }

  _write(chunk: unknown, encoding: string, callback: Callback): void {
    if (this._writev) this._writev([{ chunk, encoding }], callback);
    else throw new Error('The _write() method is not implemented');
  }

  _destroy(error: Error | null, callback: Callback): void {
    callback(error);
  }

  write(chunk: unknown, encoding?: string | Callback, callback?: Callback): boolean {
    if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined];
    const s = this._writableState;
    if (s.ending || s.destroyed) {
      const error = Object.assign(new Error(s.destroyed ? 'Cannot call write after a stream was destroyed' : 'write after end'), { code: s.destroyed ? 'ERR_STREAM_DESTROYED' : 'ERR_STREAM_WRITE_AFTER_END' });
      tick(() => {
        callback?.(error);
        this.emit('error', error);
      });
      return false;
    }
    let value = chunk;
    let enc = encoding ?? s.defaultEncoding;
    if (!s.objectMode) {
      if (typeof value === 'string' && s.decodeStrings) {
        value = Buffer.from(value, enc);
        enc = 'buffer';
      } else if (value instanceof Uint8Array) {
        if (!(value instanceof Buffer)) value = Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
        enc = 'buffer';
      } else if (typeof value !== 'string') {
        throw new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array');
      }
    }
    s.length += s.objectMode ? 1 : (value as { length: number }).length;
    s.queue.push({ chunk: value, encoding: enc, callback });
    const ok = s.length < s.highWaterMark;
    if (!ok) s.needDrain = true;
    if (!s.corked) this._drainQueue();
    return ok;
  }

  end(chunk?: unknown, encoding?: string | Callback, callback?: Callback): this {
    if (typeof chunk === 'function') [callback, chunk] = [chunk as Callback, undefined];
    else if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined];
    const s = this._writableState;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding as string | undefined);
    if (callback) {
      if (s.finished) tick(() => callback!());
      else this.once('finish', () => callback!());
    }
    if (s.ending) return this;
    s.ending = true;
    s.corked = 0;
    this._drainQueue();
    return this;
  }

  cork(): void {
    this._writableState.corked++;
  }

  uncork(): void {
    const s = this._writableState;
    if (s.corked) s.corked--;
    if (!s.corked) this._drainQueue();
  }

  setDefaultEncoding(encoding: string): this {
    this._writableState.defaultEncoding = encoding;
    return this;
  }

  destroy(error?: Error | null): this {
    const s = this._writableState;
    if (s.destroyed) return this;
    s.destroyed = true;
    if (error) s.errored = error;
    this._destroy(error ?? null, (err) => {
      tick(() => {
        if (err) this.emit('error', err);
        s.closed = true;
        if (s.emitClose) this.emit('close');
      });
    });
    return this;
  }

  _drainQueue(): void {
    const s = this._writableState;
    if (s.writing || s.destroyed) return;
    const next = s.queue.shift();
    if (!next) {
      if (s.ending) this._finishMaybe();
      return;
    }
    s.writing = true;
    let sync = true;
    const done = (error?: Error | null) => {
      const after = () => {
        s.writing = false;
        s.length -= s.objectMode ? 1 : (next.chunk as { length: number }).length;
        next.callback?.(error ?? null);
        if (error) {
          s.errored = error;
          this.destroy(error);
          return;
        }
        if (s.needDrain && s.length === 0) {
          s.needDrain = false;
          this.emit('drain');
        }
        this._drainQueue();
      };
      if (sync) tick(after); // never re-enter write() callers synchronously
      else after();
    };
    try {
      this._write(next.chunk, next.encoding, done);
    } catch (error) {
      done(error as Error);
    }
    sync = false;
  }

  private _finishMaybe(): void {
    const s = this._writableState;
    if (s.finished || s.finalCalled || s.writing || s.queue.length) return;
    s.finalCalled = true;
    s.ended = true;
    const finish = (error?: Error | null) => {
      if (error) {
        this.destroy(error);
        return;
      }
      s.finished = true;
      this.emit('finish');
      const readable = (this as { _readableState?: { endEmitted: boolean } })._readableState;
      if (s.autoDestroy && (!readable || readable.endEmitted)) this.destroy();
    };
    if (this._final) this._final((error) => tick(() => finish(error)));
    else tick(() => finish());
  }
}
