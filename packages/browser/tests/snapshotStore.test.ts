import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createSnapshotStore } from '../src/snapshotStore.js';

const bytes = (...values: number[]) => new Uint8Array(values);

const settle = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));

describe('createSnapshotStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves, loads and removes snapshots', async () => {
    const store = createSnapshotStore({ indexedDB: new IDBFactory() });
    expect(await store.load('a')).toBeUndefined();
    expect(await store.save('a', bytes(1, 2, 3))).toBe(true);
    expect(await store.load('a')).toEqual(bytes(1, 2, 3));
    await store.remove('a');
    expect(await store.keys()).toEqual([]);
  });

  it('keeps only the most recently used entries and refuses oversized ones', async () => {
    const store = createSnapshotStore({ indexedDB: new IDBFactory(), maxEntries: 2, maxBytes: 4 });
    await store.save('a', bytes(1));
    await new Promise((r) => setTimeout(r, 2));
    await store.save('b', bytes(2));
    await new Promise((r) => setTimeout(r, 2));
    await store.load('a'); // a is now the most recent
    await new Promise((r) => setTimeout(r, 2));
    await store.save('c', bytes(3));
    expect(await store.keys()).toEqual(['c', 'a']);
    expect(await store.save('big', bytes(1, 2, 3, 4, 5))).toBe(false);
  });

  it('misses quietly when IndexedDB is unavailable', async () => {
    const blocked = { open: () => { throw new DOMException('blocked', 'SecurityError'); } } as unknown as IDBFactory;
    const store = createSnapshotStore({ indexedDB: blocked });
    expect(await store.save('a', bytes(1))).toBe(false);
    expect(await store.load('a')).toBeUndefined();
    expect(await store.keys()).toEqual([]);
  });

  it('orders and prunes by recency without loading every zip', async () => {
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const store = createSnapshotStore({ indexedDB: new IDBFactory(), maxEntries: 1 });
    await store.save('a', bytes(1));
    await new Promise((r) => setTimeout(r, 2));
    await store.save('b', bytes(2));
    expect(await store.keys()).toEqual(['b']);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('upgrades a version-1 database, keeping its snapshots and their recency', async () => {
    const factory = new IDBFactory();
    const open = factory.open('bfwc-snapshots', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('snapshots', { keyPath: 'key' });
    const v1 = await settle(open);
    const tx = v1.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put({ key: 'old', zip: bytes(1), usedAt: 1 });
    tx.objectStore('snapshots').put({ key: 'new', zip: bytes(2), usedAt: 2 });
    await new Promise((r) => (tx.oncomplete = r));
    v1.close();

    const store = createSnapshotStore({ indexedDB: factory });
    expect(await store.keys()).toEqual(['new', 'old']);
    expect(await store.load('old')).toEqual(bytes(1));
    expect(await store.keys()).toEqual(['old', 'new']);
  });
});
