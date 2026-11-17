/**
 * Phase 1 — Local CPU Inference Engine: model asset cache.
 *
 * Stores quantized model weights in IndexedDB so a model provisioned once is
 * available offline for every later session. Keys are the model id; entries
 * carry the bytes plus a small metadata record (or, with `valueFormat: 'raw'`,
 * just the bytes — see `ModelCacheOptions.valueFormat`). Uses the same defensive
 * posture as the rest of the runtime: if IndexedDB is unavailable the cache
 * is a no-op and provisioning simply re-downloads.
 *
 * Buffer ownership contract (every `ModelCache` implementation): `put` must not
 * retain the caller's `bytes` buffer (IndexedDB structured-clones it; the
 * in-memory cache copies it), and `get` returns a buffer the caller owns and
 * may transfer. That is what lets `InferenceClient.load()` transfer the bytes
 * to the worker without making its own copy.
 */

import { lazyIdbStore } from '../shared/idb.js';

export interface ModelCacheEntry {
  /** Model id, e.g. `builderforce/tiny-instruct-q4`. */
  id: string;
  /** Absent on legacy entries stored as raw bytes. */
  quantization?: string;
  /** Absent on legacy entries stored as raw bytes. */
  paramsB?: number;
  bytes: ArrayBuffer;
  /** Byte length of `bytes`, recorded at put time for bookkeeping. */
  size: number;
  /** When the entry was written, epoch ms (0 for legacy raw-bytes entries). */
  storedAt: number;
}

export interface ModelCache {
  get(id: string): Promise<ModelCacheEntry | undefined>;
  put(id: string, entry: Omit<ModelCacheEntry, 'id' | 'storedAt'>): Promise<void>;
  has(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
  /** Ids currently held, for capacity management and diagnostics. */
  keys(): Promise<string[]>;
}

/**
 * IndexedDB-backed model cache. Pass an explicit `indexedDB` in tests (the
 * `fake-indexeddb` package is already a dev dependency of this package);
 * in the browser it defaults to the global.
 *
 * `dbName` / `storeName` / `dbVersion` let a host adopt an existing weights
 * database (e.g. Builderforce Studio's `builderforce-studio-weights` / `weights`
 * / v1, whose values are raw ArrayBuffers keyed by path) without migrating it.
 */
export interface ModelCacheOptions {
  indexedDB?: IDBFactory;
  /** Default `bfwc-inference-models`. */
  dbName?: string;
  /** Default `models`. */
  storeName?: string;
  /** Default 1. The upgrade only creates the store when it is missing. */
  dbVersion?: number;
  /**
   * How `put` stores a value. Default `'entry'`.
   * - `'entry'`: a `ModelCacheEntry` object (bytes + metadata).
   * - `'raw'`: the `ArrayBuffer` itself, with no wrapper — byte-identical to
   *   Builderforce Studio's legacy weights format, so older builds on the same
   *   origin keep reading what this cache writes. `quantization` / `paramsB`
   *   are NOT persisted in raw mode; `get` returns `{ id, bytes, size, storedAt: 0 }`.
   *
   * `get` reads both shapes in either mode.
   */
  valueFormat?: ModelCacheValueFormat;
}

export type ModelCacheValueFormat = 'entry' | 'raw';

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/** Normalise a stored value: a legacy raw ArrayBuffer is wrapped as an entry. */
function toEntry(id: string, value: unknown): ModelCacheEntry | undefined {
  if (value === undefined || value === null) return undefined;
  if (isArrayBuffer(value)) return { id, bytes: value, size: value.byteLength, storedAt: 0 };
  return value as ModelCacheEntry;
}

export function createModelCache(options: ModelCacheOptions = {}): ModelCache {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const config = {
    dbName: options.dbName ?? 'bfwc-inference-models',
    storeName: options.storeName ?? 'models',
    version: options.dbVersion ?? 1,
  };
  const raw = options.valueFormat === 'raw';
  const open = lazyIdbStore(factory, config);

  return {
    async get(id) {
      const store = await open();
      if (!store) return undefined;
      return toEntry(id, await store.run('readonly', (s) => s.get(id) as IDBRequest<unknown>));
    },
    async put(id, entry) {
      const store = await open();
      if (!store) return;
      const value: ArrayBuffer | ModelCacheEntry = raw ? entry.bytes : { ...entry, id, storedAt: Date.now() };
      await store.run('readwrite', (s) => s.put(value, id));
    },
    async has(id) {
      const store = await open();
      if (!store) return false;
      return (await store.run('readonly', (s) => s.count(id))) > 0;
    },
    async delete(id) {
      await (await open())?.run('readwrite', (s) => s.delete(id));
    },
    async keys() {
      const store = await open();
      if (!store) return [];
      return (await store.run('readonly', (s) => s.getAllKeys())).map(String);
    },
  };
}

/** In-memory cache for tests and non-persistent fallbacks. Copies on put and get (see the ownership contract). */
export function createMemoryModelCache(): ModelCache {
  const map = new Map<string, ModelCacheEntry>();
  return {
    async get(id) {
      const entry = map.get(id);
      return entry ? { ...entry, bytes: entry.bytes.slice(0) } : undefined;
    },
    async put(id, entry) {
      map.set(id, { ...entry, bytes: entry.bytes.slice(0), id, storedAt: Date.now() });
    },
    async has(id) {
      return map.has(id);
    },
    async delete(id) {
      map.delete(id);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}
