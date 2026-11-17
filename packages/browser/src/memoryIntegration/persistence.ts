/**
 * Phase 6 — persistence for the knowledge layer. IndexedDB in the browser via the
 * shared `lazyIdbStore` helper (no IndexedDB ⇒ a no-op store and the index is
 * simply rebuilt), plus an in-memory implementation for tests.
 */

import { lazyIdbStore } from '../shared/idb.js';
import type { KnowledgePersistence, StoredKnowledgeDoc } from './types.js';

const DB_VERSION = 1;
const STORE = 'docs';

export interface IndexedDbKnowledgePersistenceOptions {
  indexedDB?: IDBFactory;
  /** Database name; one per knowledge collection. Default `bfwc-memory-knowledge`. */
  dbName?: string;
}

export function createIndexedDbKnowledgePersistence(
  options: IndexedDbKnowledgePersistenceOptions = {},
): KnowledgePersistence {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const config = { dbName: options.dbName ?? 'bfwc-memory-knowledge', storeName: STORE, version: DB_VERSION };
  const open = lazyIdbStore(factory, config);
  return {
    async load() {
      const store = await open();
      if (!store) return [];
      return store.run('readonly', (s) => s.getAll() as IDBRequest<StoredKnowledgeDoc[]>);
    },
    async put(doc) {
      await (await open())?.run('readwrite', (s) => s.put(doc, doc.id));
    },
    async delete(id) {
      await (await open())?.run('readwrite', (s) => s.delete(id));
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
