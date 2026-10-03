/**
 * `zlib` over fflate: gzip/deflate/raw deflate in sync, callback, promise-less
 * and streaming forms (compression middleware pipes through `createGzip`).
 * Brotli is not available and says so.
 */
import * as fflate from 'fflate';
import { Buffer } from './buffer.js';
import { Transform } from './stream/index.js';

type Input = string | ArrayBufferView | ArrayBuffer;
type Options = { level?: number };

const bytes = (input: Input): Uint8Array =>
  typeof input === 'string' ? Buffer.from(input) : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

const level = (options?: Options) => (options?.level === undefined || options.level < 0 ? 6 : Math.min(9, options.level)) as fflate.DeflateOptions['level'];

const SYNC: Record<string, (data: Uint8Array, options?: Options) => Uint8Array> = {
  gzip: (d, o) => fflate.gzipSync(d, { level: level(o) }),
  gunzip: (d) => fflate.gunzipSync(d),
  deflate: (d, o) => fflate.zlibSync(d, { level: level(o) }),
  inflate: (d) => fflate.unzlibSync(d),
  deflateRaw: (d, o) => fflate.deflateSync(d, { level: level(o) }),
  inflateRaw: (d) => fflate.inflateSync(d),
  unzip: (d) => fflate.decompressSync(d),
};

type StreamCtor = new (cb?: fflate.FlateStreamHandler) => { push(chunk: Uint8Array, final?: boolean): void; ondata: fflate.FlateStreamHandler };
const STREAMS: Record<string, (options?: Options) => InstanceType<StreamCtor>> = {
  Gzip: (o) => new fflate.Gzip({ level: level(o) }),
  Gunzip: () => new fflate.Gunzip(),
  Deflate: (o) => new fflate.Zlib({ level: level(o) }),
  Inflate: () => new fflate.Unzlib(),
  DeflateRaw: (o) => new fflate.Deflate({ level: level(o) }),
  InflateRaw: () => new fflate.Inflate(),
  Unzip: () => new fflate.Decompress() as unknown as InstanceType<StreamCtor>,
};

function zlibError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message || 'invalid compressed data'), { code: 'Z_DATA_ERROR', errno: -3 });
}

class ZlibStream extends Transform {
  private readonly engine: InstanceType<StreamCtor>;
  bytesWritten = 0;

  constructor(kind: string, options?: Options) {
    super();
    this.engine = STREAMS[kind]!(options);
    this.engine.ondata = (data: Uint8Array) => {
      if (data.length) this.push(Buffer.from(data));
    };
  }

  override _transform(chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      this.bytesWritten += chunk.length;
      this.engine.push(chunk, false);
      callback();
    } catch (error) {
      callback(zlibError(error));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.engine.push(new Uint8Array(0), true);
      callback();
    } catch (error) {
      callback(zlibError(error));
    }
  }

  flush(_kind?: unknown, callback?: () => void): void {
    callback?.();
  }

  params(_level: number, _strategy: number, callback?: () => void): void {
    callback?.();
  }

  close(callback?: () => void): void {
    this.destroy();
    callback?.();
  }
}

const noBrotli = () => {
  throw Object.assign(new Error('Brotli is not available in the browser runtime'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};

export function createZlibModule(): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    constants: {
      Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
      Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5,
      Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
      Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
      BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_PARAM_QUALITY: 1,
    },
    brotliCompressSync: noBrotli,
    brotliDecompressSync: noBrotli,
    brotliCompress: noBrotli,
    brotliDecompress: noBrotli,
    createBrotliCompress: noBrotli,
    createBrotliDecompress: noBrotli,
    crc32: (data: Input, value = 0) => {
      let crc = ~value >>> 0;
      for (const byte of bytes(data)) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      return ~crc >>> 0;
    },
  };
  for (const [name, fn] of Object.entries(SYNC)) {
    mod[`${name}Sync`] = (input: Input, options?: Options) => {
      try {
        return Buffer.from(fn(bytes(input), options));
      } catch (error) {
        throw zlibError(error);
      }
    };
    mod[name] = (input: Input, options: Options | ((e: Error | null, r?: Buffer) => void), callback?: (e: Error | null, r?: Buffer) => void) => {
      const cb = (typeof options === 'function' ? options : callback)!;
      queueMicrotask(() => {
        try {
          cb(null, Buffer.from(fn(bytes(input), typeof options === 'object' ? options : undefined)));
        } catch (error) {
          cb(zlibError(error));
        }
      });
    };
  }
  for (const kind of Object.keys(STREAMS)) {
    mod[`create${kind}`] = (options?: Options) => new ZlibStream(kind, options);
    mod[kind] = class extends ZlibStream {
      constructor(options?: Options) {
        super(kind, options);
      }
    };
  }
  return mod;
}
