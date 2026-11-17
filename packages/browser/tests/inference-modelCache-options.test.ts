import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createModelCache } from '../src/inference/modelCache.js';
import { lazyIdbStore, openIdbStore } from '../src/shared/idb.js';

const encoder = new TextEncoder();

/** Seed a database the way Builderforce Studio does: v1, raw ArrayBuffer values keyed by path. */
function seedLegacyDb(factory: IDBFactory, key: string, bytes: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open('builderforce-studio-weights', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('weights');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('weights', 'readwrite');
      tx.objectStore('weights').put(bytes, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('createModelCache options', () => {
  it('uses a custom dbName/storeName/dbVersion', async () => {
    const factory = new IDBFactory();
    const cache = createModelCache({ indexedDB: factory, dbName: 'custom-db', storeName: 'blobs', dbVersion: 3 });
    await cache.put('m', { bytes: encoder.encode('abc').buffer as ArrayBuffer, size: 3 });
    const entry = await cache.get('m');
    expect(entry?.id).toBe('m');
    expect(entry?.quantization).toBeUndefined();
    expect(new Uint8Array(entry!.bytes)).toEqual(encoder.encode('abc'));
    const dbs = await factory.databases();
    expect(dbs.map((d) => d.name)).toContain('custom-db');
    expect(dbs.find((d) => d.name === 'custom-db')?.version).toBe(3);
  });

  it('opens a pre-existing v1 database and wraps a raw ArrayBuffer value as an entry', async () => {
    const factory = new IDBFactory();
    const raw = encoder.encode('legacy-weights').buffer as ArrayBuffer;
    await seedLegacyDb(factory, 'models/tiny.bin', raw);

    const cache = createModelCache({
      indexedDB: factory,
      dbName: 'builderforce-studio-weights',
      storeName: 'weights',
      dbVersion: 1,
    });
    const entry = await cache.get('models/tiny.bin');
    expect(entry).toEqual({
      id: 'models/tiny.bin',
      bytes: expect.any(ArrayBuffer),
      size: raw.byteLength,
      storedAt: 0,
    });
    expect(new Uint8Array(entry!.bytes)).toEqual(encoder.encode('legacy-weights'));
    expect(await cache.has('models/tiny.bin')).toBe(true);
    expect(await cache.keys()).toEqual(['models/tiny.bin']);
  });

  it('adds a missing store without dropping an existing database', async () => {
    const factory = new IDBFactory();
    await seedLegacyDb(factory, 'k', new ArrayBuffer(2));
    // Same database, a store the seed did not create.
    const cache = createModelCache({ indexedDB: factory, dbName: 'builderforce-studio-weights', storeName: 'models' });
    await cache.put('x', { bytes: new ArrayBuffer(1), size: 1 });
    expect(await cache.has('x')).toBe(true);
    const legacy = createModelCache({ indexedDB: factory, dbName: 'builderforce-studio-weights', storeName: 'weights' });
    expect((await legacy.get('k'))?.size).toBe(2);
  });
});

/** Read one value straight out of a store, bypassing the cache. */
function readRaw(factory: IDBFactory, dbName: string, storeName: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
  });
}

describe("createModelCache valueFormat: 'raw'", () => {
  const studio = { dbName: 'builderforce-studio-weights', storeName: 'weights', dbVersion: 1 } as const;

  it('stores the ArrayBuffer itself (no wrapper), byte-identical to the legacy format', async () => {
    const factory = new IDBFactory();
    const cache = createModelCache({ indexedDB: factory, ...studio, valueFormat: 'raw' });
    await cache.put('models/tiny.bin', {
      bytes: encoder.encode('raw-weights').buffer as ArrayBuffer,
      size: 11,
      quantization: 'q4',
      paramsB: 1,
    });
    const value = await readRaw(factory, studio.dbName, studio.storeName, 'models/tiny.bin');
    expect(value instanceof ArrayBuffer).toBe(true);
    expect(new Uint8Array(value as ArrayBuffer)).toEqual(encoder.encode('raw-weights'));
  });

  it('round-trips as an entry without persisted metadata', async () => {
    const factory = new IDBFactory();
    const cache = createModelCache({ indexedDB: factory, ...studio, valueFormat: 'raw' });
    await cache.put('m', { bytes: encoder.encode('abc').buffer as ArrayBuffer, size: 3, quantization: 'q4', paramsB: 1 });
    const entry = await cache.get('m');
    expect(entry).toEqual({ id: 'm', bytes: expect.any(ArrayBuffer), size: 3, storedAt: 0 });
    expect(new Uint8Array(entry!.bytes)).toEqual(encoder.encode('abc'));
    expect(await cache.has('m')).toBe(true);
    expect(await cache.keys()).toEqual(['m']);
  });

  it("'entry' mode (the default) still writes the wrapper object", async () => {
    const factory = new IDBFactory();
    const cache = createModelCache({ indexedDB: factory, ...studio });
    await cache.put('m', { bytes: new ArrayBuffer(2), size: 2, quantization: 'q4' });
    const value = await readRaw(factory, studio.dbName, studio.storeName, 'm');
    expect(value instanceof ArrayBuffer).toBe(false);
    expect((value as { quantization?: string }).quantization).toBe('q4');
  });
});

describe('lazyIdbStore', () => {
  it('retries after a blocked open instead of memoising the failure, and closes the late connection', async () => {
    const factory = new IDBFactory();
    // A connection at v1 WITHOUT the store that never yields to a versionchange,
    // so adding the store (v1 -> v2) is blocked.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('blocked-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('other');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const open = lazyIdbStore(factory, { dbName: 'blocked-db', storeName: 's', version: 1 });
    expect(await open()).toBeUndefined();

    // Unblock: the pending v2 open now completes late; that connection must be closed.
    holder.close();
    await new Promise((r) => setTimeout(r, 20));

    // A later upgrade by someone else is not blocked by a leaked connection.
    const blocked = await new Promise<boolean>((resolve, reject) => {
      const req = factory.open('blocked-db', 3);
      let wasBlocked = false;
      req.onblocked = () => {
        wasBlocked = true;
      };
      req.onsuccess = () => {
        req.result.close();
        resolve(wasBlocked);
      };
      req.onerror = () => reject(req.error);
    });
    expect(blocked).toBe(false);

    // The next call retries and gets a working store.
    const store = await open();
    expect(store).toBeDefined();
    await store!.run('readwrite', (s) => s.put('v', 'k'));
    expect(await store!.run('readonly', (s) => s.get('k'))).toBe('v');
  });

  it('does not queue new opens behind a still-blocked upgrade; retries once it settles', async () => {
    const factory = new IDBFactory();
    // A connection at v1 WITHOUT the store and without onversionchange: the store-add
    // upgrade (v1 -> v2) stays blocked until it closes.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('still-blocked-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('other');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const within = <T,>(p: Promise<T>, ms = 200): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`open hung > ${ms}ms`)), ms)),
      ]);
    const open = lazyIdbStore(factory, { dbName: 'still-blocked-db', storeName: 's', version: 1 });
    expect(await within(open())).toBeUndefined();
    // Still blocked: a second call must not queue behind the pending upgrade.
    expect(await within(open())).toBeUndefined();
    expect(
      await within(openIdbStore(factory, { dbName: 'still-blocked-db', storeName: 's', version: 1 })),
    ).toBeUndefined();

    // Unblock: the pending upgrade settles late; the next call succeeds.
    holder.close();
    await new Promise((r) => setTimeout(r, 20));
    const store = await within(open());
    expect(store).toBeDefined();
    await store!.run('readwrite', (s) => s.put('v', 'k'));
    expect(await store!.run('readonly', (s) => s.get('k'))).toBe('v');
    store!.close();
  });

  it('reopens after the memoised connection is closed by a versionchange', async () => {
    const factory = new IDBFactory();
    const open = lazyIdbStore(factory, { dbName: 'vc-db', storeName: 's', version: 1 });
    const first = await open();
    await first!.run('readwrite', (s) => s.put('v', 'k'));
    // Another connection upgrades: ours yields instead of blocking it.
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('vc-db', 5);
      req.onblocked = () => reject(new Error('blocked by the cached connection'));
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const second = await open();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(await second!.run('readonly', (s) => s.get('k'))).toBe('v');
  });
});

describe('openIdbStore', () => {
  it('rejects when the transaction aborts instead of reporting success', async () => {
    const store = await openIdbStore(new IDBFactory(), { dbName: 'abort-db', storeName: 's', version: 1 });
    expect(store).toBeDefined();
    await expect(
      store!.run('readwrite', (s) => {
        const req = s.put('v', 'k');
        s.transaction.abort();
        return req;
      }),
    ).rejects.toBeDefined();
    expect(await store!.run('readonly', (s) => s.get('k'))).toBeUndefined();
  });

  it('resolves undefined without an IndexedDB factory', async () => {
    expect(await openIdbStore(undefined, { dbName: 'x', storeName: 's', version: 1 })).toBeUndefined();
  });
});
