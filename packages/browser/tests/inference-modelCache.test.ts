import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createModelCache, createMemoryModelCache } from '../src/inference/modelCache.js';

const encoder = new TextEncoder();

describe('createModelCache (IndexedDB)', () => {
  it('round-trips a model entry', async () => {
    const cache = createModelCache({ indexedDB: new IDBFactory() });
    expect(await cache.get('m1')).toBeUndefined();
    await cache.put('m1', {
      quantization: 'q4',
      paramsB: 1.1,
      bytes: encoder.encode('weights').buffer as ArrayBuffer,
      size: 7,
    });
    const entry = await cache.get('m1');
    expect(entry?.quantization).toBe('q4');
    expect(entry?.paramsB).toBe(1.1);
    expect(entry?.size).toBe(7);
    expect(entry?.id).toBe('m1');
    expect(typeof entry?.storedAt).toBe('number');
    expect(new Uint8Array(entry!.bytes)).toEqual(encoder.encode('weights'));
  });

  it('reports has/keys and deletes entries', async () => {
    const cache = createModelCache({ indexedDB: new IDBFactory() });
    await cache.put('a', { quantization: 'q8', paramsB: 3, bytes: new ArrayBuffer(1), size: 1 });
    await cache.put('b', { quantization: 'q4', paramsB: 1, bytes: new ArrayBuffer(1), size: 1 });
    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('zzz')).toBe(false);
    expect((await cache.keys()).sort()).toEqual(['a', 'b']);
    await cache.delete('a');
    expect(await cache.has('a')).toBe(false);
  });
});

describe('createMemoryModelCache', () => {
  it('behaves like the IndexedDB cache', async () => {
    const cache = createMemoryModelCache();
    await cache.put('m', { quantization: 'q5', paramsB: 2, bytes: new ArrayBuffer(4), size: 4 });
    expect(await cache.has('m')).toBe(true);
    expect((await cache.get('m'))?.quantization).toBe('q5');
    await cache.delete('m');
    expect(await cache.has('m')).toBe(false);
  });
});
