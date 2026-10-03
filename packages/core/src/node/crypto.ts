/**
 * The `crypto` module: hashes and HMAC (sync, via hashes.ts), random bytes and
 * UUIDs (WebCrypto's getRandomValues), pbkdf2, `timingSafeEqual`, and
 * `webcrypto`/`subtle` passed through. Ciphers, signing and key generation are
 * not shimmed — they throw a clear error rather than misbehave.
 */
import { Buffer } from './buffer.js';
import { hashAlgorithm, HASHES } from './hashes.js';
import { Transform } from './stream/index.js';

type Input = string | ArrayBufferView;

const toBytes = (data: Input, encoding?: string): Uint8Array =>
  typeof data === 'string' ? Buffer.from(data, encoding) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const output = (bytes: Uint8Array, encoding?: string) => (encoding && encoding !== 'buffer' ? Buffer.from(bytes).toString(encoding as 'hex') : Buffer.from(bytes));

class Hash extends Transform {
  private chunks: Uint8Array[] = [];
  private done = false;

  constructor(private readonly algorithm: string) {
    super();
    hashAlgorithm(algorithm);
  }

  update(data: Input, encoding?: string): this {
    if (this.done) throw Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
    this.chunks.push(toBytes(data, encoding).slice());
    return this;
  }

  digest(encoding?: string): string | Buffer {
    this.done = true;
    return output(hashAlgorithm(this.algorithm).digest(Buffer.concat(this.chunks)), encoding);
  }

  copy(): Hash {
    const copy = new Hash(this.algorithm);
    copy.chunks = [...this.chunks];
    return copy;
  }

  override _transform(chunk: Uint8Array, _encoding: string, callback: () => void): void {
    this.update(chunk);
    callback();
  }

  override _flush(callback: (error?: Error | null, data?: unknown) => void): void {
    callback(null, this.digest());
  }
}

export function hmac(algorithm: string, key: Uint8Array, data: Uint8Array): Uint8Array {
  const { digest, blockSize } = hashAlgorithm(algorithm);
  let k = key.length > blockSize ? digest(key) : key;
  const padded = new Uint8Array(blockSize);
  padded.set(k);
  k = padded;
  const inner = new Uint8Array(blockSize + data.length);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(data, blockSize);
  const innerHash = digest(inner);
  const final = new Uint8Array(blockSize + innerHash.length);
  final.set(outer);
  final.set(innerHash, blockSize);
  return digest(final);
}

class Hmac extends Hash {
  private readonly hmacKey: Uint8Array;
  private readonly parts: Uint8Array[] = [];

  constructor(private readonly hmacAlgorithm: string, key: Input) {
    super(hmacAlgorithm);
    this.hmacKey = toBytes(key).slice();
  }

  override update(data: Input, encoding?: string): this {
    this.parts.push(toBytes(data, encoding).slice());
    return this;
  }

  override digest(encoding?: string): string | Buffer {
    return output(hmac(this.hmacAlgorithm, this.hmacKey, Buffer.concat(this.parts)), encoding);
  }
}

function pbkdf2Sync(password: Input, salt: Input, iterations: number, keylen: number, digest = 'sha1'): Buffer {
  const pw = toBytes(password);
  const s = toBytes(salt);
  const out = new Uint8Array(keylen);
  for (let block = 1, at = 0; at < keylen; block++) {
    const input = new Uint8Array(s.length + 4);
    input.set(s);
    new DataView(input.buffer).setUint32(s.length, block);
    let u = hmac(digest, pw, input);
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmac(digest, pw, u);
      for (let j = 0; j < t.length; j++) t[j] = t[j]! ^ u[j]!;
    }
    out.set(t.subarray(0, keylen - at), at);
    at += t.length;
  }
  return Buffer.from(out);
}

function randomFill<T extends ArrayBufferView>(view: T): T {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < bytes.length; i += 65536) globalThis.crypto.getRandomValues(bytes.subarray(i, i + 65536));
  return view;
}

const unsupported = (name: string) => () => {
  throw Object.assign(new Error(`crypto.${name} is not available in the browser runtime`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};

export function createCryptoModule(): Record<string, unknown> {
  const randomBytes = (size: number, callback?: (error: Error | null, buf: Buffer) => void) => {
    const buf = randomFill(Buffer.alloc(size));
    if (callback) queueMicrotask(() => callback(null, buf));
    return buf;
  };
  return {
    createHash: (algorithm: string) => new Hash(algorithm),
    createHmac: (algorithm: string, key: Input) => new Hmac(algorithm, key),
    hash: (algorithm: string, data: Input, encoding = 'hex') => output(hashAlgorithm(algorithm).digest(toBytes(data)), encoding),
    getHashes: () => Object.keys(HASHES),
    getCiphers: () => [],
    getCurves: () => [],
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync: (view: ArrayBufferView, offset = 0, size?: number) => {
      randomFill(new Uint8Array(view.buffer, view.byteOffset + offset, size ?? view.byteLength - offset));
      return view;
    },
    randomFill: (view: ArrayBufferView, ...rest: unknown[]) => {
      const callback = rest.pop() as (e: Error | null, v: ArrayBufferView) => void;
      randomFill(view);
      queueMicrotask(() => callback(null, view));
    },
    randomUUID: () => globalThis.crypto.randomUUID(),
    randomInt(min: number, max?: number | ((e: Error | null, n: number) => void), callback?: (e: Error | null, n: number) => void) {
      if (typeof max !== 'number') [callback, max, min] = [max as typeof callback, min, 0];
      const value = min + Math.floor((globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) * (max - min));
      if (callback) queueMicrotask(() => callback!(null, value));
      return value;
    },
    getRandomValues: <T extends ArrayBufferView>(view: T) => randomFill(view),
    timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView) {
      if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
      const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      let diff = 0;
      for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
      return diff === 0;
    },
    pbkdf2Sync,
    pbkdf2(password: Input, salt: Input, iterations: number, keylen: number, digest: string, callback: (e: Error | null, key?: Buffer) => void) {
      queueMicrotask(() => {
        try {
          callback(null, pbkdf2Sync(password, salt, iterations, keylen, digest));
        } catch (error) {
          callback(error as Error);
        }
      });
    },
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto?.subtle,
    constants: {},
    createCipheriv: unsupported('createCipheriv'),
    createDecipheriv: unsupported('createDecipheriv'),
    createSign: unsupported('createSign'),
    createVerify: unsupported('createVerify'),
    generateKeyPairSync: unsupported('generateKeyPairSync'),
    generateKeyPair: unsupported('generateKeyPair'),
    createPrivateKey: unsupported('createPrivateKey'),
    createPublicKey: unsupported('createPublicKey'),
    scryptSync: unsupported('scryptSync'),
    scrypt: unsupported('scrypt'),
  };
}
