/**
 * stream.Readable — flowing and paused modes, `pipe` with backpressure,
 * `setEncoding`, async iteration and `Readable.from`. State lives in
 * `_readableState` with Node's field names, because packages (on-finished,
 * destroy, readable-stream interop) peek at it.
 */
import { EventEmitterBase } from '../events.js';
import { Buffer } from '../buffer.js';

export const tick = (fn: () => void) => queueMicrotask(fn);

export interface ReadableOptions {
  highWaterMark?: number;
  encoding?: string;
  objectMode?: boolean;
  readableObjectMode?: boolean;
  read?(this: Readable, size: number): void;
  destroy?(this: Readable, error: Error | null, callback: (error?: Error | null) => void): void;
  autoDestroy?: boolean;
  emitClose?: boolean;
  signal?: AbortSignal;
}

export interface ReadableState {
  objectMode: boolean;
  highWaterMark: number;
  buffer: unknown[];
  length: number;
  flowing: boolean | null;
  ended: boolean;
  endEmitted: boolean;
  reading: boolean;
  destroyed: boolean;
  closed: boolean;
  errored: Error | null;
  encoding: string | null;
  autoDestroy: boolean;
  emitClose: boolean;
  flowScheduled: boolean;
  pipes: unknown[];
}

const chunkLength = (state: ReadableState, chunk: unknown) => (state.objectMode ? 1 : (chunk as { length: number }).length);

export function initReadable(self: Readable, options: ReadableOptions = {}): void {
  const objectMode = !!(options.objectMode || options.readableObjectMode);
  self._readableState = {
    objectMode,
    highWaterMark: options.highWaterMark ?? (objectMode ? 16 : 16 * 1024),
    buffer: [],
    length: 0,
    flowing: null,
    ended: false,
    endEmitted: false,
    reading: false,
    destroyed: false,
    closed: false,
    errored: null,
    encoding: options.encoding ?? null,
    autoDestroy: options.autoDestroy ?? true,
    emitClose: options.emitClose ?? true,
    flowScheduled: false,
    pipes: [],
  };
  if (typeof options.read === 'function') self._read = options.read;
  if (typeof options.destroy === 'function') self._destroy = options.destroy;
  options.signal?.addEventListener('abort', () => self.destroy(new Error('The operation was aborted')));
}

export class Readable extends EventEmitterBase {
  declare _readableState: ReadableState;

  constructor(options?: ReadableOptions) {
    super();
    initReadable(this, options);
  }

  static from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options: ReadableOptions = {}): Readable {
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
      const r = new Readable({ objectMode: false, ...options, read() {} });
      r.push(iterable);
      r.push(null);
      return r;
    }
    const iterator = (Symbol.asyncIterator in iterable ? (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]() : (iterable as Iterable<unknown>)[Symbol.iterator]()) as AsyncIterator<unknown> | Iterator<unknown>;
    let pulling = false;
    return new Readable({
      objectMode: true,
      ...options,
      async read() {
        if (pulling) return;
        pulling = true;
        try {
          for (;;) {
            const { value, done } = await iterator.next();
            if (done) {
              this.push(null);
              break;
            }
            if (!this.push(await value)) break;
          }
        } catch (error) {
          this.destroy(error as Error);
        } finally {
          pulling = false;
        }
      },
    });
  }

  get readable(): boolean {
    const s = this._readableState;
    return !!s && !s.destroyed && !s.endEmitted && !s.errored;
  }
  set readable(_value: boolean) {
    // legacy code assigns this; state is authoritative
  }
  get readableEnded(): boolean { return this._readableState.endEmitted; }
  get readableFlowing(): boolean | null { return this._readableState.flowing; }
  get readableLength(): number { return this._readableState.length; }
  get readableHighWaterMark(): number { return this._readableState.highWaterMark; }
  get readableObjectMode(): boolean { return this._readableState.objectMode; }
  get readableEncoding(): string | null { return this._readableState.encoding; }
  get destroyed(): boolean { return this._readableState.destroyed; }
  set destroyed(value: boolean) { this._readableState.destroyed = value; }
  get closed(): boolean { return this._readableState.closed; }
  get errored(): Error | null { return this._readableState.errored; }

  _read(_size: number): void {
    throw new Error('The _read() method is not implemented');
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    callback(error);
  }

  push(chunk: unknown, encoding?: string): boolean {
    const s = this._readableState;
    s.reading = false;
    if (chunk === null) {
      s.ended = true;
      this._scheduleFlow();
      return false;
    }
    if (s.ended || s.destroyed) return false;
    let value = chunk;
    if (!s.objectMode) {
      if (typeof value === 'string') value = s.encoding ? value : Buffer.from(value, encoding);
      else if (value instanceof Uint8Array && !(value instanceof Buffer)) value = Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
      if (s.encoding && value instanceof Uint8Array) value = (value as Buffer).toString(s.encoding as 'utf8');
      if ((value as { length: number }).length === 0) return s.length < s.highWaterMark;
    }
    s.buffer.push(value);
    s.length += chunkLength(s, value);
    this._scheduleFlow();
    return s.length < s.highWaterMark;
  }

  unshift(chunk: unknown): void {
    const s = this._readableState;
    s.buffer.unshift(chunk);
    s.length += chunkLength(s, chunk);
  }

  read(n?: number): unknown {
    const s = this._readableState;
    if (!s.buffer.length) {
      if (s.ended) this._scheduleFlow();
      else this._pull();
      return null;
    }
    let out: unknown;
    if (s.objectMode) out = s.buffer.shift();
    else if (n === undefined || n >= s.length) {
      if (n !== undefined && n > s.length && !s.ended) {
        this._pull();
        return null;
      }
      out = s.encoding ? (s.buffer as string[]).join('') : s.buffer.length === 1 ? s.buffer[0] : Buffer.concat(s.buffer as Uint8Array[]);
      s.buffer = [];
    } else {
      const all = s.encoding ? (s.buffer as string[]).join('') : Buffer.concat(s.buffer as Uint8Array[]);
      out = all.slice(0, n);
      s.buffer = [all.slice(n)];
    }
    s.length -= chunkLength(s, out);
    if (s.length < s.highWaterMark) this._pull();
    if (s.ended && !s.buffer.length) this._scheduleFlow();
    return out;
  }

  setEncoding(encoding: string): this {
    const s = this._readableState;
    s.encoding = encoding;
    s.buffer = s.buffer.map((c) => (c instanceof Uint8Array ? (c as Buffer).toString(encoding as 'utf8') : c));
    return this;
  }

  override on(event: string | symbol, listener: (...args: any[]) => unknown): this {
    super.on(event, listener);
    const s = this._readableState;
    if (event === 'data' && s.flowing !== false) this.resume();
    if (event === 'readable') {
      s.flowing = false;
      this._scheduleFlow();
    }
    return this;
  }

  override addListener(event: string | symbol, listener: (...args: any[]) => unknown): this {
    return this.on(event, listener);
  }

  resume(): this {
    this._readableState.flowing = true;
    this._scheduleFlow();
    return this;
  }

  pause(): this {
    this._readableState.flowing = false;
    return this;
  }

  isPaused(): boolean {
    return this._readableState.flowing === false;
  }

  pipe<T extends { write(chunk: unknown): boolean; end(): unknown; on?(e: string, l: () => void): unknown; once?(e: string, l: () => void): unknown; emit?(e: string, ...a: unknown[]): unknown }>(dest: T, options: { end?: boolean } = {}): T {
    const s = this._readableState;
    s.pipes.push(dest);
    const onData = (chunk: unknown) => {
      if (dest.write(chunk) === false) {
        this.pause();
        (dest.once ?? dest.on)?.call(dest, 'drain', () => this.resume());
      }
    };
    this.on('data', onData);
    if (options.end !== false) this.once('end', () => dest.end());
    dest.emit?.('pipe', this);
    this.resume();
    return dest;
  }

  unpipe(dest?: unknown): this {
    const s = this._readableState;
    s.pipes = dest ? s.pipes.filter((p) => p !== dest) : [];
    if (!s.pipes.length) this.removeAllListeners('data');
    return this;
  }

  destroy(error?: Error | null): this {
    const s = this._readableState;
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

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    const s = this._readableState;
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    const signal = () => {
      wake?.();
      wake = undefined;
    };
    this.on('readable', signal);
    this.on('end', signal);
    this.on('close', signal);
    this.on('error', (error: Error) => {
      failure = error;
      signal();
    });
    try {
      for (;;) {
        if (failure) throw failure;
        const chunk = this.read();
        if (chunk !== null) {
          yield chunk;
          continue;
        }
        if (s.endEmitted || (s.ended && !s.length) || s.destroyed) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      if (!s.endEmitted) this.destroy();
    }
  }

  /** Ask the implementation for more data, once at a time. */
  _pull(): void {
    const s = this._readableState;
    if (s.reading || s.ended || s.destroyed) return;
    s.reading = true;
    try {
      this._read(s.highWaterMark);
    } catch (error) {
      this.destroy(error as Error);
    }
  }

  _scheduleFlow(): void {
    const s = this._readableState;
    if (s.flowScheduled) return;
    s.flowScheduled = true;
    tick(() => {
      s.flowScheduled = false;
      this._flow();
    });
  }

  private _flow(): void {
    const s = this._readableState;
    if (s.destroyed) return;
    if (s.flowing === false && s.buffer.length) this.emit('readable');
    while (s.flowing === true && s.buffer.length) {
      const chunk = s.buffer.shift();
      s.length -= chunkLength(s, chunk);
      this.emit('data', chunk);
    }
    if (s.ended && !s.buffer.length) {
      if (!s.endEmitted && (s.flowing !== null || this.listenerCount('end') || this.listenerCount('readable'))) {
        if (s.flowing === false) this.emit('readable');
        s.endEmitted = true;
        this.emit('end');
        // A duplex is destroyed only once BOTH sides are done (see Writable's finish).
        const writable = (this as { _writableState?: { finished: boolean } })._writableState;
        if (s.autoDestroy && (!writable || writable.finished)) this.destroy();
      }
      return;
    }
    if (s.flowing && s.length < s.highWaterMark) this._pull();
  }
}
