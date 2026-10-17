import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSnapshotStore } from '../src/snapshotStore.js';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('createSnapshotStore', () => {
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
});
