/**
 * Phase 6 — persistence for the knowledge layer. IndexedDB in the browser (same
 * defensive posture as `inference/modelCache.ts`: no IndexedDB ⇒ a no-op store and
 * the index is simply rebuilt), plus an in-memory implementation for tests.
 */

import type { KnowledgePersistence, StoredKnowledgeDoc } from './types.js';

const DB_VERSION = 1;
const STORE = 'docs';

export interface IndexedDbKnowledgePersistenceOptions {
  indexedDB?: IDBFactory;
  /** Database name; one per knowledge collection. Default `bfwc-memory-knowledge`. */
  dbName?: string;
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, DB_VERSION);
    } catch {
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
  });
}

export function createIndexedDbKnowledgePersistence(
  options: IndexedDbKnowledgePersistenceOptions = {},
): KnowledgePersistence {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const name = options.dbName ?? 'bfwc-memory-knowledge';
  let opened: Promise<IDBDatabase | undefined> | undefined;
  const open = () => (opened ??= factory ? openDb(factory, name) : Promise.resolve(undefined));
  return {
    async load() {
      const db = await open();
      if (!db) return [];
      return run(db, 'readonly', (s) => s.getAll() as IDBRequest<StoredKnowledgeDoc[]>);
    },
    async put(doc) {
      const db = await open();
      if (db) await run(db, 'readwrite', (s) => s.put(doc, doc.id));
    },
    async delete(id) {
      const db = await open();
      if (db) await run(db, 'readwrite', (s) => s.delete(id));
    },
  };
}

/** Non-persistent store (tests, or a session-only knowledge layer). */
export function createMemoryKnowledgePersistence(): KnowledgePersistence {
  const map = new Map<string, StoredKnowledgeDoc>();
  return {
    async load() {
      return [...map.values()];
    },
    async put(doc) {
      map.set(doc.id, doc);
    },
    async delete(id) {
      map.delete(id);
    },
  };
}
