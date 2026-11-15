/**
 * Phase 1 — Local CPU Inference Engine: model asset cache.
 *
 * Stores quantized model weights in IndexedDB so a model provisioned once is
 * available offline for every later session. Keys are the model id; entries
 * carry the bytes plus a small metadata record. Uses the same defensive
 * posture as the rest of the runtime: if IndexedDB is unavailable the cache
 * is a no-op and provisioning simply re-downloads.
 */

export interface ModelCacheEntry {
  /** Model id, e.g. `builderforce/tiny-instruct-q4`. */
  id: string;
  quantization: string;
  paramsB: number;
  bytes: ArrayBuffer;
  /** Byte length of `bytes`, recorded at put time for bookkeeping. */
  size: number;
  /** When the entry was written, epoch ms. */
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

const DB_NAME = 'bfwc-inference-models';
const DB_VERSION = 1;
const STORE = 'models';

interface ModelDb {
  get(key: string): Promise<ModelCacheEntry | undefined>;
  put(key: string, value: ModelCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function openDb(indexedDB: IDBFactory): Promise<ModelDb | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      const run = <T>(fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise((resolveReq, rejectReq) => {
          const tx = db.transaction(STORE, 'readwrite');
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolveReq(req.result);
          req.onerror = () => rejectReq(req.error);
        });
      resolve({
        get: (key) => run((store) => store.get(key) as IDBRequest<ModelCacheEntry | undefined>),
        put: (key, value) => run((store) => store.put(value, key)).then(() => undefined),
        delete: (key) => run((store) => store.delete(key)).then(() => undefined),
        keys: () => run((store) => store.getAllKeys() as IDBRequest<string[]>),
      });
    };
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

/**
 * IndexedDB-backed model cache. Pass an explicit `indexedDB` in tests (the
 * `fake-indexeddb` package is already a dev dependency of this package);
 * in the browser it defaults to the global.
 */
export interface ModelCacheOptions {
  indexedDB?: IDBFactory;
}

export function createModelCache(options: ModelCacheOptions = {}): ModelCache {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  let opened: Promise<ModelDb | undefined> | undefined;
  const open = () => (opened ??= factory ? openDb(factory) : Promise.resolve(undefined));

  return {
    async get(id) {
      return (await open())?.get(id);
    },
    async put(id, entry) {
      const store = await open();
      if (!store) return;
      await store.put(id, { ...entry, id, storedAt: Date.now() });
    },
    async has(id) {
      return (await this.get(id)) !== undefined;
    },
    async delete(id) {
      await (await open())?.delete(id);
    },
    async keys() {
      return (await open())?.keys() ?? [];
    },
  };
}

/** In-memory cache for tests and non-persistent fallbacks. */
export function createMemoryModelCache(): ModelCache {
  const map = new Map<string, ModelCacheEntry>();
  return {
    async get(id) {
      return map.get(id);
    },
    async put(id, entry) {
      map.set(id, { ...entry, id, storedAt: Date.now() });
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
