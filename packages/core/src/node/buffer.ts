/**
 * Node's Buffer as a Uint8Array subclass — the common surface: encodings
 * (utf8, hex, base64/base64url, latin1/binary, ascii, utf16le), `from`/`alloc`/
 * `concat`, view-sharing `slice`, search, and the fixed-width integer and float
 * readers/writers parsers rely on. Written here rather than pulling in the
 * CommonJS `buffer` package so the core stays native ESM.
 */

export type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function normalizeEncoding(encoding: unknown): string {
  const e = String(encoding ?? 'utf8').toLowerCase();
  switch (e) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'hex': return 'hex';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'latin1': case 'binary': return 'latin1';
    case 'ascii': return 'ascii';
    case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
    default: throw new TypeError(`Unknown encoding: ${String(encoding)}`);
  }
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/\-_]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(clean.length % 4 === 1 ? padded.slice(0, -3) : padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export function encode(text: string, encoding?: unknown): Uint8Array {
  switch (normalizeEncoding(encoding)) {
    case 'utf8': return utf8Encoder.encode(text);
    case 'hex': {
      const length = Math.floor(text.length / 2);
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const byte = parseInt(text.substr(i * 2, 2), 16);
        if (Number.isNaN(byte)) return out.subarray(0, i);
        out[i] = byte;
      }
      return out;
    }
    case 'base64': case 'base64url': return base64ToBytes(text);
    case 'utf16le': {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >> 8;
      }
      return out;
    }
    default: { // latin1, ascii
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
  }
}

export function decode(bytes: Uint8Array, encoding?: unknown): string {
  switch (normalizeEncoding(encoding)) {
    case 'utf8': return utf8Decoder.decode(bytes);
    case 'hex': return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    case 'base64': return btoa(bytesToBinaryString(bytes));
    case 'base64url': return btoa(bytesToBinaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    case 'ascii': return bytesToBinaryString(bytes.map((b) => b & 0x7f));
    case 'utf16le': {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      return out;
    }
    default: return bytesToBinaryString(bytes);
  }
}

type BufferSource = string | ArrayBuffer | ArrayLike<number> | Uint8Array | { type: 'Buffer'; data: number[] };

// Typed loosely: Node's `Buffer.from` overloads are not assignable to Uint8Array.from's.
const Uint8ArrayBase = Uint8Array as unknown as new (...args: any[]) => Uint8Array<ArrayBuffer>;

export class Buffer extends Uint8ArrayBase {
  static poolSize = 8192;

  constructor(arg: number | BufferSource, encodingOrOffset?: unknown, length?: number) {
    if (typeof arg === 'string') super(encode(arg, encodingOrOffset));
    else if (arg instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && arg instanceof SharedArrayBuffer)) super(arg as ArrayBuffer, encodingOrOffset as number | undefined, length);
    else super(arg as ArrayLike<number>);
  }

  static from(value: BufferSource, encodingOrOffset?: unknown, length?: number): Buffer {
    if (typeof value === 'string') return new Buffer(encode(value, encodingOrOffset));
    if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset, length);
    if (ArrayBuffer.isView(value)) return new Buffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); // a copy
    if (value && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) return new Buffer((value as { data: number[] }).data);
    if (value && typeof value === 'object' && typeof (value as { length?: unknown }).length === 'number') return new Buffer(value as ArrayLike<number>);
    throw new TypeError('The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object.');
  }

  static alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer {
    const buf = new Buffer(size);
    if (fill !== undefined && fill !== 0) buf.fill(fill, 0, size, encoding);
    return buf;
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size);
  }

  static allocUnsafeSlow(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer;
  }

  static isEncoding(encoding: unknown): boolean {
    try {
      normalizeEncoding(encoding);
      return typeof encoding === 'string';
    } catch {
      return false;
    }
  }

  static byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): number {
    if (typeof value === 'string') return encode(value, encoding).length;
    return value.byteLength;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((n, b) => n + b.length, 0);
    const out = Buffer.alloc(total);
    let at = 0;
    for (const item of list) {
      if (at >= total) break;
      out.set(item.subarray(0, total - at), at);
      at += item.length;
    }
    return out;
  }

  static compare(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return Math.sign(a.length - b.length);
  }

  get parent(): ArrayBufferLike {
    return this.buffer;
  }

  override toString(encoding?: BufferEncoding, start = 0, end = this.length): string {
    return decode(this.subarray(Math.max(0, start), Math.min(this.length, end)), encoding);
  }

  toLocaleString(): string {
    return this.toString();
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0;
  }

  compare(target: Uint8Array, targetStart = 0, targetEnd = target.length, sourceStart = 0, sourceEnd = this.length): number {
    return Buffer.compare(this.subarray(sourceStart, sourceEnd), target.subarray(targetStart, targetEnd));
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const chunk = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + (target.length - targetStart)));
    target.set(chunk, targetStart);
    return chunk.length;
  }

  /** Node's slice is a VIEW, unlike TypedArray#slice. */
  override slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end) as Buffer;
  }

  override subarray(start?: number, end?: number): Buffer {
    const view = super.subarray(start, end);
    return new Buffer(view.buffer as ArrayBuffer, view.byteOffset, view.length);
  }

  write(text: string, offset?: number | string, length?: number | string, encoding?: string): number {
    if (typeof offset === 'string') [encoding, offset, length] = [offset, 0, undefined];
    else if (typeof length === 'string') [encoding, length] = [length, undefined];
    const at = offset ?? 0;
    const bytes = encode(text, encoding).subarray(0, Math.min((length as number | undefined) ?? Infinity, this.length - at));
    this.set(bytes, at);
    return bytes.length;
  }

  override fill(value: string | number | Uint8Array, start: number | string = 0, end: number = this.length, encoding?: BufferEncoding): this {
    if (typeof start === 'string') [encoding, start] = [start as BufferEncoding, 0];
    if (typeof value === 'number') return super.fill(value & 255, start, end);
    const pattern = typeof value === 'string' ? encode(value, encoding) : value;
    if (!pattern.length) return super.fill(0, start, end);
    for (let i = start, j = 0; i < end; i++, j = (j + 1) % pattern.length) this[i] = pattern[j]!;
    return this;
  }

  override indexOf(value: string | number | Uint8Array, byteOffset = 0, encoding?: BufferEncoding): number {
    if (typeof value === 'number') return super.indexOf(value & 255, byteOffset);
    const needle = typeof value === 'string' ? encode(value, encoding) : value;
    const from = byteOffset < 0 ? Math.max(0, this.length + byteOffset) : byteOffset;
    if (!needle.length) return Math.min(from, this.length);
    outer: for (let i = from; i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  override lastIndexOf(value: string | number | Uint8Array, byteOffset = this.length, encoding?: BufferEncoding): number {
    if (typeof value === 'number') return super.lastIndexOf(value & 255, byteOffset);
    const needle = typeof value === 'string' ? encode(value, encoding) : value;
    outer: for (let i = Math.min(byteOffset, this.length - needle.length); i >= 0; i--) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  override includes(value: string | number | Uint8Array, byteOffset = 0, encoding?: BufferEncoding): boolean {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }

  private view(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  readUInt8(o = 0) { return this.view().getUint8(o); }
  readUInt16LE(o = 0) { return this.view().getUint16(o, true); }
  readUInt16BE(o = 0) { return this.view().getUint16(o); }
  readUInt32LE(o = 0) { return this.view().getUint32(o, true); }
  readUInt32BE(o = 0) { return this.view().getUint32(o); }
  readInt8(o = 0) { return this.view().getInt8(o); }
  readInt16LE(o = 0) { return this.view().getInt16(o, true); }
  readInt16BE(o = 0) { return this.view().getInt16(o); }
  readInt32LE(o = 0) { return this.view().getInt32(o, true); }
  readInt32BE(o = 0) { return this.view().getInt32(o); }
  readFloatLE(o = 0) { return this.view().getFloat32(o, true); }
  readFloatBE(o = 0) { return this.view().getFloat32(o); }
  readDoubleLE(o = 0) { return this.view().getFloat64(o, true); }
  readDoubleBE(o = 0) { return this.view().getFloat64(o); }
  readBigUInt64LE(o = 0) { return this.view().getBigUint64(o, true); }
  readBigUInt64BE(o = 0) { return this.view().getBigUint64(o); }
  readBigInt64LE(o = 0) { return this.view().getBigInt64(o, true); }
  readBigInt64BE(o = 0) { return this.view().getBigInt64(o); }
  writeUInt8(v: number, o = 0) { this.view().setUint8(o, v); return o + 1; }
  writeUInt16LE(v: number, o = 0) { this.view().setUint16(o, v, true); return o + 2; }
  writeUInt16BE(v: number, o = 0) { this.view().setUint16(o, v); return o + 2; }
  writeUInt32LE(v: number, o = 0) { this.view().setUint32(o, v, true); return o + 4; }
  writeUInt32BE(v: number, o = 0) { this.view().setUint32(o, v); return o + 4; }
  writeInt8(v: number, o = 0) { this.view().setInt8(o, v); return o + 1; }
  writeInt16LE(v: number, o = 0) { this.view().setInt16(o, v, true); return o + 2; }
  writeInt16BE(v: number, o = 0) { this.view().setInt16(o, v); return o + 2; }
  writeInt32LE(v: number, o = 0) { this.view().setInt32(o, v, true); return o + 4; }
  writeInt32BE(v: number, o = 0) { this.view().setInt32(o, v); return o + 4; }
  writeFloatLE(v: number, o = 0) { this.view().setFloat32(o, v, true); return o + 4; }
  writeFloatBE(v: number, o = 0) { this.view().setFloat32(o, v); return o + 4; }
  writeDoubleLE(v: number, o = 0) { this.view().setFloat64(o, v, true); return o + 8; }
  writeDoubleBE(v: number, o = 0) { this.view().setFloat64(o, v); return o + 8; }
  writeBigUInt64LE(v: bigint, o = 0) { this.view().setBigUint64(o, v, true); return o + 8; }
  writeBigUInt64BE(v: bigint, o = 0) { this.view().setBigUint64(o, v); return o + 8; }
}

// Lower-case aliases (readUint8 etc.) that Node also exposes.
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
  const alias = name.replace(/UInt/, 'Uint');
  if (alias !== name) Object.defineProperty(Buffer.prototype, alias, Object.getOwnPropertyDescriptor(Buffer.prototype, name)!);
}

export function createBufferModule(): Record<string, unknown> {
  return {
    Buffer,
    SlowBuffer: Buffer,
    kMaxLength: 2 ** 31 - 1,
    constants: { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 },
    INSPECT_MAX_BYTES: 50,
    Blob: globalThis.Blob,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
  };
}
