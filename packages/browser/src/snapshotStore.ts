/**
 * Snapshots that outlive the page: `exportZip` bytes kept in IndexedDB under a
 * key the host chooses (say, the project id plus a hash of package.json), so a
 * reload can `importZip` an installed `node_modules` instead of reinstalling.
 *
 * Bounded: snapshots over `maxBytes` are not stored, and only the
 * `maxEntries` most recently used are kept. Recency is read from a `usedAt`
 * index walked with a key cursor, so pruning and `keys()` never load a zip. Every operation fails soft —
 * storage blocked (private windows) or full means a miss, never a throw.
 */

export interface SnapshotStoreOptions {
  /** IndexedDB database name. Default `bfwc-snapshots`. */
  name?: string;
  /** Snapshots kept, least recently used dropped first. Default 4. */
  maxEntries?: number;
  /** Largest snapshot stored, in bytes. Default 256 MB. */
  maxBytes?: number;
  /** Injected for tests; defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

export interface SnapshotStore {
  /** The snapshot saved under `key`, or undefined. */
  load(key: string): Promise<Uint8Array | undefined>;
  /** Save (replacing any snapshot under `key`); false when it was not stored (too large, storage unavailable). */
  save(key: string, zip: Uint8Array): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** Keys held, most recently used first. */
  keys(): Promise<string[]>;
}

interface Row {
  key: string;
  zip: Uint8Array;
  usedAt: number;
}

const STORE = 'snapshots';
const USED_AT = 'usedAt';
/** v1: the store; v2: the `usedAt` index (built over existing rows by the upgrade itself). */
const DB_VERSION = 2;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function createSnapshotStore(options: SnapshotStoreOptions = {}): SnapshotStore {
  const maxEntries = options.maxEntries ?? 4;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  let opening: Promise<IDBDatabase | undefined> | undefined;

  const open = () =>
    (opening ??= (async () => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) return undefined;
      try {
        const req = factory.open(options.name ?? 'bfwc-snapshots', DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          const store = db.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'key' });
          if (!store.indexNames.contains(USED_AT)) store.createIndex(USED_AT, USED_AT);
        };
        return await request(req);
      } catch {
        return undefined;
      }
    })());

  /** Keys, most recently used first — walked off the `usedAt` index; no zip is read. */
  const keysByRecency = (db: IDBDatabase): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const keys: string[] = [];
      const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).index(USED_AT).openKeyCursor(null, 'prev');
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return resolve(keys);
        keys.push(at.primaryKey as string);
        at.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });

  return {
    async load(key) {
      const db = await open();
      if (!db) return undefined;
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const row = (await request(store.get(key))) as Row | undefined;
        if (row) store.put({ ...row, usedAt: Date.now() });
        await done(tx);
        return row?.zip;
      } catch {
        return undefined;
      }
    },
    async save(key, zip) {
      if (zip.byteLength > maxBytes) return false;
      const db = await open();
      if (!db) return false;
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, zip, usedAt: Date.now() } satisfies Row);
        await done(tx);
        const stale = (await keysByRecency(db)).slice(maxEntries);
        if (stale.length) {
          const prune = db.transaction(STORE, 'readwrite');
          for (const staleKey of stale) prune.objectStore(STORE).delete(staleKey);
          await done(prune);
        }
        return true;
      } catch {
        return false;
      }
    },
    async remove(key) {
      const db = await open();
      if (!db) return;
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        await done(tx);
      } catch {
        // storage unavailable: nothing to remove
      }
    },
    async keys() {
      const db = await open();
      if (!db) return [];
      try {
        return await keysByRecency(db);
      } catch {
        return [];
      }
    },
  };
}
