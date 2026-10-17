/**
 * Snapshots that outlive the page: `exportZip` bytes kept in IndexedDB under a
 * key the host chooses (say, the project id plus a hash of package.json), so a
 * reload can `importZip` an installed `node_modules` instead of reinstalling.
 *
 * Bounded: snapshots over `maxBytes` are not stored, and only the
 * `maxEntries` most recently used are kept. Every operation fails soft —
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
        const req = factory.open(options.name ?? 'bfwc-snapshots', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        return await request(req);
      } catch {
        return undefined;
      }
    })());

  const rows = async (db: IDBDatabase): Promise<Row[]> => {
    const all = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) as Row[];
    return all.sort((a, b) => b.usedAt - a.usedAt);
  };

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
        const stale = (await rows(db)).slice(maxEntries);
        if (stale.length) {
          const prune = db.transaction(STORE, 'readwrite');
          for (const row of stale) prune.objectStore(STORE).delete(row.key);
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
        return (await rows(db)).map((row) => row.key);
      } catch {
        return [];
      }
    },
  };
}
