/**
 * Phase 3 — browser-storage residency sink.
 *
 * CPU-only environments have no VRAM. Cold weights spill to browser storage
 * and reload from there. This sink is the residency view over the Phase 1
 * IndexedDB `ModelCache` (`src/inference/modelCache.ts`): it does not open a
 * second database and does not reimplement persistence. Tests inject
 * `createMemoryModelCache()`; the browser injects `createModelCache()`.
 *
 * Spilled bytes are NOT charged against the RAM byte budget. A reload copies
 * them back into a resident entry the caller admits.
 */

import type { ModelCache, ModelCacheEntry } from '../inference/modelCache.js';
import type { ResidentEntry } from './types.js';

/** A spill record. Payload bytes live in the Phase 1 model cache. */
export interface SpilledRecord {
  id: string;
  group: string;
  component?: string;
  bytes: number;
  reloadCostMs: number;
  reuseProbability: number;
  /** Model-cache key the payload was stored under. */
  cacheKey: string;
  spilledAt: number;
}

export interface StorageSink {
  /** Persist a resident's payload and return the spill record. */
  spill(entry: ResidentEntry, now: number): Promise<SpilledRecord>;
  /** Reload a spilled record's payload. Undefined if storage lost it. */
  reload(record: SpilledRecord): Promise<ResidentEntry | undefined>;
  /** Drop a spill. Best-effort. */
  delete(record: SpilledRecord): Promise<void>;
  /** Ids currently spilled, for diagnostics. */
  keys(): Promise<string[]>;
}

export interface StorageSinkOptions {
  /** Phase 1 model cache. Required — this module does not open IndexedDB itself. */
  cache: ModelCache;
  /**
   * Encode an opaque payload to bytes for the model cache.
   * Default: binary payloads (ArrayBuffer, SharedArrayBuffer, any TypedArray,
   * DataView) are stored as their raw bytes and come back as the same type;
   * everything else is UTF-8 JSON.
   */
  encode?: (payload: unknown) => ArrayBuffer;
  /**
   * Inverse of `encode` for non-binary payloads. Default: UTF-8 JSON parse,
   * falling back to the raw buffer. Binary payloads written by the default
   * encoder never pass through here.
   */
  decode?: (bytes: ArrayBuffer) => unknown;
}

const CACHE_PREFIX = 'bfwc-resident:';

/** Copy the exact encoded bytes. `TextEncoder#encode().buffer` may be a larger pooled slab. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Adapt a Phase 1 `ModelCache` into a residency spill sink.
 * One cache key per resident id. Metadata rides in the cache entry's
 * quantization/params fields plus a JSON header stored ahead of the payload,
 * so a reload reconstructs the resident without a second store.
 */
export function createModelCacheSink(options: StorageSinkOptions): StorageSink {
  const decode = options.decode ?? defaultDecode;
  const cache = options.cache;

  return {
    async spill(entry, now) {
      const encoded: EncodedPayload = options.encode
        ? { encoding: 'custom', bytes: options.encode(entry.payload) }
        : defaultEncode(entry.payload);
      const header = encodeHeader(entry, now, encoded.encoding);
      const bytes = concat(header, encoded.bytes);
      await cache.put(cacheKey(entry.id), {
        quantization: entry.component ?? 'resident',
        paramsB: entry.bytes / 1e9,
        bytes,
        size: bytes.byteLength,
      });
      return {
        id: entry.id,
        group: entry.group,
        component: entry.component,
        bytes: entry.bytes,
        reloadCostMs: entry.reloadCostMs,
        reuseProbability: entry.reuseProbability,
        cacheKey: cacheKey(entry.id),
        spilledAt: now,
      };
    },
    async reload(record) {
      const stored = await cache.get(record.cacheKey);
      if (!stored) return undefined;
      const split = splitHeader(stored.bytes);
      if (!split) return undefined;
      const header = decodeHeader(split.header);
      return {
        id: record.id,
        group: header?.group ?? record.group,
        component: header?.component ?? record.component,
        bytes: record.bytes,
        reloadCostMs: record.reloadCostMs,
        reuseProbability: record.reuseProbability,
        tier: 'ram',
        payload: decodePayload(header?.encoding, split.payload, decode),
      };
    },
    async delete(record) {
      await cache.delete(record.cacheKey);
    },
    async keys() {
      const all = await cache.keys();
      return all.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => key.slice(CACHE_PREFIX.length));
    },
  };
}

/**
 * In-memory sink for tests that do not want IndexedDB. Still ModelCache-shaped.
 * The payload is kept by reference, so binary payloads (ArrayBuffer,
 * TypedArray) reload as the very same object — nothing is serialized.
 */
export function createMemorySink(): StorageSink {
  const records = new Map<string, { record: SpilledRecord; entry: ResidentEntry }>();
  return {
    async spill(entry, now) {
      const record: SpilledRecord = {
        id: entry.id,
        group: entry.group,
        component: entry.component,
        bytes: entry.bytes,
        reloadCostMs: entry.reloadCostMs,
        reuseProbability: entry.reuseProbability,
        cacheKey: cacheKey(entry.id),
        spilledAt: now,
      };
      records.set(entry.id, { record, entry: { ...entry, tier: 'storage' } });
      return record;
    },
    async reload(record) {
      const found = records.get(record.id);
      if (!found) return undefined;
      return { ...found.entry, tier: 'ram' };
    },
    async delete(record) {
      records.delete(record.id);
    },
    async keys() {
      return [...records.keys()];
    },
  };
}

function cacheKey(id: string): string {
  return `${CACHE_PREFIX}${id}`;
}

/**
 * Little-endian uint32 length prefix, then UTF-8 JSON. The header records how
 * the payload was encoded so binary payloads are restored as binary. Headers
 * written before `encoding` existed decode as JSON, as they always did.
 */
function encodeHeader(entry: ResidentEntry, now: number, encoding: PayloadEncoding): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({
    group: entry.group,
    component: entry.component,
    bytes: entry.bytes,
    spilledAt: now,
    encoding,
  }));
  const header = new Uint8Array(4 + json.byteLength);
  new DataView(header.buffer).setUint32(0, json.byteLength, true);
  header.set(json, 4);
  return header;
}

function concat(header: Uint8Array, payload: ArrayBuffer): ArrayBuffer {
  const body = new Uint8Array(payload);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return exactBuffer(out);
}

function splitHeader(bytes: ArrayBuffer): { header: string; payload: ArrayBuffer } | undefined {
  if (bytes.byteLength < 4) return undefined;
  const length = new DataView(bytes).getUint32(0, true);
  if (!Number.isFinite(length) || length < 0 || 4 + length > bytes.byteLength) return undefined;
  return {
    header: new TextDecoder().decode(bytes.slice(4, 4 + length)),
    payload: bytes.slice(4 + length),
  };
}

function decodeHeader(header: string): { group?: string; component?: string; encoding?: string } | undefined {
  try {
    const parsed = JSON.parse(header) as { group?: string; component?: string; encoding?: string };
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * How a payload was encoded. `json` / `custom` go through `decode`; the rest
 * are raw bytes restored as their original binary type.
 */
type PayloadEncoding = 'json' | 'custom' | 'arraybuffer' | 'dataview' | `typed:${string}`;

interface EncodedPayload {
  encoding: PayloadEncoding;
  bytes: ArrayBuffer;
}

type TypedArrayCtor = new (buffer: ArrayBuffer) => ArrayBufferView;

/** TypedArray constructors this realm has, by name. Resolved lazily (BigInt arrays may be absent). */
function typedArrayCtor(name: string): TypedArrayCtor | undefined {
  const known = [
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  ];
  if (!known.includes(name)) return undefined;
  const ctor = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof ctor === 'function' ? (ctor as TypedArrayCtor) : undefined;
}

/** Brand check that also works across realms (workers, iframes, test environments). */
function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function copyBytes(view: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): ArrayBuffer {
  const out = new Uint8Array(view.byteLength);
  out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out.buffer as ArrayBuffer;
}

function defaultEncode(payload: unknown): EncodedPayload {
  const tag = tagOf(payload);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    const buffer = payload as ArrayBufferLike;
    return { encoding: 'arraybuffer', bytes: copyBytes({ buffer, byteOffset: 0, byteLength: buffer.byteLength }) };
  }
  if (ArrayBuffer.isView(payload)) {
    const bytes = copyBytes(payload);
    if (tag === '[object DataView]') return { encoding: 'dataview', bytes };
    const name = payload.constructor?.name ?? '';
    if (typedArrayCtor(name)) return { encoding: `typed:${name}`, bytes };
    // An exotic view (a subclass): keep the bytes, restore as a plain buffer.
    return { encoding: 'arraybuffer', bytes };
  }
  return { encoding: 'json', bytes: exactBuffer(new TextEncoder().encode(JSON.stringify(payload ?? null))) };
}

function decodePayload(
  encoding: string | undefined,
  bytes: ArrayBuffer,
  decode: (bytes: ArrayBuffer) => unknown,
): unknown {
  if (encoding === 'arraybuffer') return bytes;
  if (encoding === 'dataview') return new DataView(bytes);
  if (encoding?.startsWith('typed:')) {
    const ctor = typedArrayCtor(encoding.slice('typed:'.length));
    return ctor ? new ctor(bytes) : bytes;
  }
  return decode(bytes);
}

function defaultDecode(bytes: ArrayBuffer): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return bytes;
  }
}

/** Re-export the Phase 1 entry type so callers need not import inference for a spill. */
export type { ModelCacheEntry };
