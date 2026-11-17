import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createMemoryModelCache, createModelCache } from '../src/inference/modelCache.js';
import { lruStrategy } from '../src/memory/eviction.js';
import { createMemoryManager } from '../src/memory/manager.js';
import { createMemorySink, createModelCacheSink, type StorageSink } from '../src/memory/storageSink.js';
import type { ResidentEntry } from '../src/memory/types.js';

function entry(id: string, bytes: number, payload: unknown = { id }): ResidentEntry {
  return { id, group: 'model', bytes, reloadCostMs: 10, reuseProbability: 0.1, tier: 'ram', payload };
}

/** A sink whose writes take `delayMs`, optionally failing the first `failFirst` writes. */
function slowSink(delayMs: number, failFirst = 0): StorageSink {
  const inner = createMemorySink();
  let failures = failFirst;
  return {
    ...inner,
    async spill(resident, now) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failures > 0) {
        failures -= 1;
        throw new Error('quota exceeded');
      }
      return inner.spill(resident, now);
    },
  };
}

describe('spill tier — storage budget under concurrency', () => {
  it('reserves bytes before awaiting the sink so concurrent spills cannot overshoot', async () => {
    const manager = createMemoryManager({
      byteBudget: 10,
      strategy: lruStrategy(),
      storage: slowSink(5),
      storageBudgetBytes: 100,
    });
    // Both entries exceed the RAM budget, so both go straight to storage, concurrently.
    const [first, second] = await Promise.all([
      manager.admit(entry('big-1', 60)),
      manager.admit(entry('big-2', 60)),
    ]);
    expect([first.spilled, second.spilled].filter(Boolean)).toHaveLength(1);
    expect(manager.stats().spilledBytes).toBeLessThanOrEqual(100);
    expect(manager.stats().spilledCount).toBe(1);
  });

  it('releases the reservation when a spill write fails', async () => {
    const manager = createMemoryManager({
      byteBudget: 10,
      strategy: lruStrategy(),
      storage: slowSink(1, 1),
      storageBudgetBytes: 100,
    });
    const failed = await manager.admit(entry('big-1', 60));
    expect(failed.spilled).toBe(false);
    expect(manager.stats().spilledBytes).toBe(0);
    // A leaked reservation would leave only 40 bytes; the full budget is available again.
    const retried = await manager.admit(entry('big-2', 90));
    expect(retried.spilled).toBe(true);
    expect(manager.stats().spilledBytes).toBe(90);
  });
});

describe('storage sink — binary payloads (regression: default encode was JSON.stringify → {})', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);

  it('spills and reloads an ArrayBuffer through the IndexedDB model cache', async () => {
    const sink = createModelCacheSink({ cache: createModelCache({ indexedDB: new IDBFactory() }) });
    const record = await sink.spill(entry('weights', 6, bytes.slice().buffer), 1);
    const restored = await sink.reload(record);
    // Brand check (not instanceof): the IndexedDB clone may come from another realm.
    expect(Object.prototype.toString.call(restored?.payload)).toBe('[object ArrayBuffer]');
    expect([...new Uint8Array(restored?.payload as ArrayBuffer)]).toEqual([...bytes]);
  });

  it('restores a TypedArray as the same TypedArray type with the same values', async () => {
    const sink = createModelCacheSink({ cache: createMemoryModelCache() });
    const floats = new Float32Array([1.5, -2.25, 3]);
    const record = await sink.spill(entry('floats', floats.byteLength, floats), 1);
    const restored = (await sink.reload(record))?.payload;
    expect(restored).toBeInstanceOf(Float32Array);
    expect([...(restored as Float32Array)]).toEqual([1.5, -2.25, 3]);

    // A view into a larger buffer stores only the viewed bytes.
    const window = new Uint8Array(bytes.buffer, 2, 3);
    const viewRecord = await sink.spill(entry('window', 3, window), 1);
    expect([...((await sink.reload(viewRecord))?.payload as Uint8Array)]).toEqual([2, 250, 251]);
  });

  it('still round-trips plain objects as JSON', async () => {
    const sink = createModelCacheSink({ cache: createMemoryModelCache() });
    const record = await sink.spill(entry('obj', 8, { rows: [1, 2] }), 1);
    expect((await sink.reload(record))?.payload).toEqual({ rows: [1, 2] });
  });

  it('keeps an ArrayBuffer payload as binary across a manager spill and reload', async () => {
    const manager = createMemoryManager({
      byteBudget: 10,
      strategy: lruStrategy(),
      storage: createModelCacheSink({ cache: createMemoryModelCache() }),
      storageBudgetBytes: 100,
    });
    await manager.admit(entry('cold', 6, bytes.slice().buffer));
    await manager.admit(entry('hot', 6)); // evicts and spills `cold`
    expect(manager.get('cold').hit).toBe(false);
    const reloaded = await manager.reload('cold');
    expect(reloaded.hit).toBe(true);
    expect([...new Uint8Array(reloaded.entry?.payload as ArrayBuffer)]).toEqual([...bytes]);
  });

  it('the in-memory sink keeps binary payloads as-is', async () => {
    const sink = createMemorySink();
    const buffer = bytes.slice().buffer;
    const record = await sink.spill(entry('raw', 6, buffer), 1);
    expect((await sink.reload(record))?.payload).toBe(buffer);
  });
});
