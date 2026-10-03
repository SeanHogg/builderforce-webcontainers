/**
 * Duplex, Transform, PassThrough, the legacy `Stream` base, and the `stream`
 * module object with `pipeline`/`finished` (callback and promise forms).
 */
import { EventEmitterBase } from '../events.js';
import { callable } from '../callable.js';
import { initReadable, Readable, tick, type ReadableOptions } from './readable.js';
import { initWritable, Writable, type WritableOptions } from './writable.js';

type Callback = (error?: Error | null) => void;
type AnyStream = EventEmitterBase & { destroy?(error?: Error): unknown; pipe?(dest: unknown, opts?: unknown): unknown; _readableState?: { endEmitted: boolean }; _writableState?: { finished: boolean } };

/** The pre-streams2 base class: an emitter with a simple `pipe`. */
class LegacyStream extends EventEmitterBase {
  pipe(dest: { write(chunk: unknown): boolean; end(): void }): unknown {
    this.on('data', (chunk: unknown) => dest.write(chunk));
    this.on('end', () => dest.end());
    return dest;
  }
}
Object.setPrototypeOf(Readable.prototype, LegacyStream.prototype);
Object.setPrototypeOf(Writable.prototype, LegacyStream.prototype);

export interface DuplexOptions extends Omit<ReadableOptions, 'destroy'>, Omit<WritableOptions, 'destroy'> {
  allowHalfOpen?: boolean;
  destroy?(this: Duplex, error: Error | null, callback: (error?: Error | null) => void): void;
}

function initDuplex(self: Duplex, options: DuplexOptions = {}): void {
  initReadable(self, options as ReadableOptions);
  initWritable(self as unknown as Writable, options as WritableOptions);
  self.allowHalfOpen = options.allowHalfOpen !== false;
  if (!self.allowHalfOpen) self.once('end', () => (self as unknown as Writable).end());
}

export interface Duplex extends Omit<Writable, keyof EventEmitterBase | 'destroy' | 'destroyed' | '_destroy' | '_write' | '_final'> {
  _write(chunk: any, encoding: string, callback: Callback): void;
  _final?(callback: Callback): void;
}
export class Duplex extends Readable {
  declare allowHalfOpen: boolean;

  constructor(options?: DuplexOptions) {
    super(options);
    initDuplex(this, options);
  }

  override destroy(error?: Error | null): this {
    const w = this._writableState;
    if (w) w.destroyed = true;
    return super.destroy(error);
  }
}
for (const key of Object.getOwnPropertyNames(Writable.prototype)) {
  if (key === 'constructor' || key === 'destroy' || key === 'destroyed' || key === '_destroy' || key in Duplex.prototype && Object.getOwnPropertyDescriptor(Duplex.prototype, key)) continue;
  Object.defineProperty(Duplex.prototype, key, Object.getOwnPropertyDescriptor(Writable.prototype, key)!);
}

export interface TransformOptions extends DuplexOptions {
  transform?(this: Transform, chunk: any, encoding: string, callback: (error?: Error | null, data?: unknown) => void): void;
  flush?(this: Transform, callback: (error?: Error | null, data?: unknown) => void): void;
}

function initTransform(self: Transform, options: TransformOptions = {}): void {
  initDuplex(self, options);
  if (typeof options.transform === 'function') self._transform = options.transform;
  if (typeof options.flush === 'function') self._flush = options.flush;
}

export class Transform extends Duplex {
  _flush?(callback: (error?: Error | null, data?: unknown) => void): void;

  constructor(options?: TransformOptions) {
    super(options);
    initTransform(this, options);
  }

  _transform(_chunk: unknown, _encoding: string, _callback: (error?: Error | null, data?: unknown) => void): void {
    throw new Error('The _transform() method is not implemented');
  }

  override _read(): void {
    // data is pushed as it is written
  }

  _write(chunk: unknown, encoding: string, callback: Callback): void {
    this._transform(chunk, encoding, (error, data) => {
      if (error) return callback(error);
      if (data !== undefined && data !== null) this.push(data);
      callback();
    });
  }

  _final(callback: Callback): void {
    const done = (error?: Error | null, data?: unknown) => {
      if (error) return callback(error);
      if (data !== undefined && data !== null) this.push(data);
      this.push(null);
      callback();
    };
    if (this._flush) this._flush(done);
    else done();
  }
}

export class PassThrough extends Transform {
  override _transform(chunk: unknown, _encoding: string, callback: (error?: Error | null, data?: unknown) => void): void {
    callback(null, chunk);
  }
}

/** Call back once when `stream` has ended, finished, errored or closed. */
export function finished(stream: AnyStream, options: unknown, callback?: Callback): () => void {
  const cb = (typeof options === 'function' ? options : callback) as Callback;
  let done = false;
  const once = (error?: Error | null) => {
    if (done) return;
    done = true;
    cleanup();
    cb(error ?? null);
  };
  const onError = (error: Error) => once(error);
  const onEnd = () => once();
  const onClose = () => {
    const r = stream._readableState;
    const w = stream._writableState;
    if ((r && !r.endEmitted) || (w && !w.finished)) once(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    else once();
  };
  const isWritableOnly = !!stream._writableState && !stream._readableState;
  stream.on('error', onError);
  stream.on(isWritableOnly ? 'finish' : 'end', onEnd);
  if (stream._readableState && stream._writableState) stream.on('finish', () => stream._readableState!.endEmitted && once());
  stream.on('close', onClose);
  const cleanup = () => {
    stream.removeListener('error', onError);
    stream.removeListener('end', onEnd);
    stream.removeListener('finish', onEnd);
    stream.removeListener('close', onClose);
  };
  if ((stream._readableState?.endEmitted && !stream._writableState) || (isWritableOnly && stream._writableState!.finished)) tick(() => once());
  return cleanup;
}

export function pipeline(...args: unknown[]): unknown {
  const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as Callback) : undefined;
  const streams = (Array.isArray(args[0]) ? args[0] : args) as AnyStream[];
  if (streams.length < 2) throw new Error('pipeline requires at least two streams');
  let failed = false;
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    for (const s of streams) s.destroy?.(error);
    callback?.(error);
  };
  for (let i = 0; i < streams.length - 1; i++) streams[i]!.pipe!(streams[i + 1]);
  streams.forEach((s, i) => {
    if (i < streams.length - 1) s.on('error', fail);
  });
  const last = streams[streams.length - 1]!;
  finished(last, (error?: Error | null) => {
    if (error) fail(error);
    else if (!failed) callback?.(null);
  });
  return last;
}

export function createStreamModule(): Record<string, unknown> {
  const Stream = callable(LegacyStream, () => undefined) as unknown as Record<string, unknown>;
  const wrapped = {
    Readable: callable(Readable, (self, options) => initReadable(self, options)),
    Writable: callable(Writable, (self, options) => initWritable(self, options)),
    Duplex: callable(Duplex, (self, options) => initDuplex(self, options)),
    Transform: callable(Transform, (self, options) => initTransform(self, options)),
    PassThrough: callable(PassThrough, (self, options) => initTransform(self, options)),
  };
  const promises = {
    pipeline: (...streams: unknown[]) => new Promise<void>((resolve, reject) => pipeline(...streams, (error?: Error | null) => (error ? reject(error) : resolve()))),
    finished: (stream: AnyStream) => new Promise<void>((resolve, reject) => finished(stream, (error?: Error | null) => (error ? reject(error) : resolve()))),
  };
  Object.assign(Stream, wrapped, {
    Stream,
    pipeline,
    finished,
    promises,
    addAbortSignal: (_signal: AbortSignal, stream: unknown) => stream,
    isReadable: (s: Readable) => !!s?.readable,
    isErrored: (s: Readable) => !!s?._readableState?.errored,
    isDisturbed: (s: Readable) => !!s?._readableState?.endEmitted || (s?._readableState?.flowing ?? null) !== null,
    getDefaultHighWaterMark: (objectMode: boolean) => (objectMode ? 16 : 16 * 1024),
    setDefaultHighWaterMark: () => undefined,
  });
  return Stream;
}

export { Readable, Writable, tick };
