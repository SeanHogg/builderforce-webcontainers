import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createMemoryModelCache, createModelCache } from '../src/inference/modelCache.js';
import {
  arcStrategy,
  costAwareStrategy,
  lfuStrategy,
  lruStrategy,
  retentionValue,
} from '../src/residency/eviction.js';
import { estimateReloadCostMs, estimateReuseProbability, estimateWeightBytes } from '../src/residency/estimates.js';
import { createMemoryManager, probeRamBytes, probeStorageQuotaBytes } from '../src/residency/manager.js';
import { detectPressure, planWorkspace } from '../src/residency/pressure.js';
import { createMemorySink, createModelCacheSink } from '../src/residency/storageSink.js';
import type { ResidentEntry, TrackedEntry } from '../src/residency/types.js';

function entry(id: string, bytes: number, extra: Partial<ResidentEntry> = {}): ResidentEntry {
  return {
    id,
    group: extra.group ?? 'model',
    component: extra.component,
    bytes,
    reloadCostMs: extra.reloadCostMs ?? 10,
    reuseProbability: extra.reuseProbability ?? 0.1,
    tier: extra.tier ?? 'ram',
    payload: extra.payload ?? { id, bytes },
    pinned: extra.pinned,
  };
}

function touch(manager: ReturnType<typeof createMemoryManager>, id: string, times: number): void {
  for (let i = 0; i < times; i++) manager.get(id);
}

describe('eviction strategies', () => {
  const candidates: TrackedEntry[] = [
    { ...entry('cold', 100), admittedAt: 1, lastUsedAt: 1, hits: 0 },
    { ...entry('hot', 100, { reuseProbability: 0.9, reloadCostMs: 500 }), admittedAt: 2, lastUsedAt: 9, hits: 8 },
    { ...entry('mid', 100), admittedAt: 3, lastUsedAt: 4, hits: 2 },
  ];

  it('LRU evicts the least recently used first', () => {
    expect(lruStrategy().rank(candidates).map((e) => e.id)).toEqual(['cold', 'mid', 'hot']);
  });

  it('LFU evicts the least frequently used first', () => {
    expect(lfuStrategy().rank(candidates).map((e) => e.id)).toEqual(['cold', 'mid', 'hot']);
  });

  it('cost-aware evicts the lowest retention-value per byte first', () => {
    const ranked = costAwareStrategy().rank(candidates);
    expect(ranked[0]?.id).toBe('cold');
    expect(ranked[ranked.length - 1]?.id).toBe('hot');
    expect(retentionValue(candidates[1]!)).toBeGreaterThan(retentionValue(candidates[0]!));
  });

  it('ARC keeps ghost lists bounded and still returns every candidate', () => {
    const strategy = arcStrategy(2);
    for (let i = 0; i < 8; i++) {
      strategy.observe?.({
        kind: 'evict',
        entry: { ...entry(`g${i}`, 1), admittedAt: i, lastUsedAt: i, hits: i % 2 },
      });
    }
    const ranked = strategy.rank(candidates);
    expect(ranked.map((e) => e.id).sort()).toEqual(['cold', 'hot', 'mid']);
  });
});

describe('reuse and reload estimates', () => {
  it('weights reuse probability against reload cost and footprint', () => {
    const cold = estimateReuseProbability({ hits: 0, misses: 10, idleMs: 120_000 });
    const hot = estimateReuseProbability({ hits: 20, misses: 0, idleMs: 0 });
    expect(hot).toBeGreaterThan(cold);
    expect(hot).toBeLessThanOrEqual(1);
    expect(cold).toBeGreaterThanOrEqual(0);
    expect(estimateReloadCostMs({ bytes: 50_000, from: 'storage' })).toBeGreaterThan(0);
    expect(estimateReloadCostMs({ bytes: 50_000, from: 'network' })).toBeGreaterThan(
      estimateReloadCostMs({ bytes: 50_000, from: 'storage' }),
    );
    expect(estimateWeightBytes(1.1, 'q4')).toBe(Math.round(1.1e9 * 0.5 * 1.2));
  });
});

describe('pressure and workspace', () => {
  it('reports pressure and a reclaim target once the watermark is crossed', () => {
    const calm = detectPressure({
      usedBytes: 100,
      byteBudget: 1_000,
      pressureThreshold: 0.85,
      targetWatermark: 0.7,
      ramBytes: 1,
      vramBytes: 0,
      storageQuotaBytes: 0,
    });
    expect(calm.pressured).toBe(false);
    expect(calm.reclaimBytes).toBe(0);
    const hot = detectPressure({ ...calm, usedBytes: 900, byteBudget: 1_000, pressureThreshold: 0.85, targetWatermark: 0.7, ramBytes: 1, vramBytes: 0, storageQuotaBytes: 0 });
    expect(hot.pressured).toBe(true);
    expect(hot.reclaimBytes).toBeGreaterThan(0);
  });

  it('grows the workspace on a hit and shrinks it under pressure, inside the budget', () => {
    const bounds = { minBytes: 100, maxBytes: 500 };
    const grown = planWorkspace({
      currentBytes: 100,
      bounds,
      pressure: detectPressure({
        usedBytes: 100,
        byteBudget: 1_000,
        pressureThreshold: 0.85,
        targetWatermark: 0.7,
        ramBytes: 1,
        vramBytes: 0,
        storageQuotaBytes: 0,
      }),
      byteBudget: 1_000,
      usedBytes: 100,
      onHit: true,
    });
    expect(grown.deltaBytes).toBeGreaterThan(0);
    expect(grown.nextBytes).toBeLessThanOrEqual(500);
    const shrunk = planWorkspace({
      currentBytes: 400,
      bounds,
      pressure: detectPressure({
        usedBytes: 900,
        byteBudget: 1_000,
        pressureThreshold: 0.85,
        targetWatermark: 0.7,
        ramBytes: 1,
        vramBytes: 0,
        storageQuotaBytes: 0,
      }),
      byteBudget: 1_000,
      usedBytes: 900,
      onHit: false,
    });
    expect(shrunk.deltaBytes).toBeLessThan(0);
    expect(shrunk.nextBytes).toBeGreaterThanOrEqual(100);
  });
});

describe('createMemoryManager', () => {
  it('measures hit rate and shows a cache benefit on a repeated workload', async () => {
    const manager = createMemoryManager({ byteBudget: 1_000, strategy: lruStrategy(), storageBudgetBytes: 0 });
    await manager.admit(entry('keep', 100, { payload: { weights: [1, 2, 3] } }));
    expect(manager.get('keep').hit).toBe(true);
    expect(manager.get('missing').hit).toBe(false);
    expect(manager.get('keep').hit).toBe(true);
    expect(manager.hitRate()).toBeGreaterThan(0);
    expect(manager.hitRate()).toBeCloseTo(2 / 3);
    expect(manager.stats().hitRate).toBe(manager.hitRate());
    expect(manager.peek('keep')?.payload).toEqual({ weights: [1, 2, 3] });
  });

  it('bounds memory by the hard byte budget and does not grow without limit', async () => {
    const budget = 1_000;
    const manager = createMemoryManager({
      byteBudget: budget,
      strategy: lruStrategy(),
      storage: createMemorySink(),
      storageBudgetBytes: 2_000,
    });
    for (let i = 0; i < 200; i++) {
      const result = await manager.admit(entry(`w${i}`, 100, { payload: { i } }));
      expect(result.admitted || result.spilled).toBe(true);
      expect(manager.stats().usedBytes).toBeLessThanOrEqual(budget);
      expect(manager.stats().spilledBytes).toBeLessThanOrEqual(2_000);
    }
    expect(manager.stats().residentCount).toBeLessThanOrEqual(10);
    expect(manager.stats().evictions).toBeGreaterThan(0);
    expect(manager.stats().spilledCount).toBeLessThanOrEqual(20);
  });

  it('evicts without corrupting entries that remain resident', async () => {
    const manager = createMemoryManager({ byteBudget: 300, strategy: lruStrategy(), storageBudgetBytes: 0 });
    await manager.admit(entry('live', 100, { payload: { tensor: 'keep-me' } }));
    await manager.admit(entry('stale', 100, { payload: { tensor: 'drop-me' } }));
    // Touch after stale is admitted so LRU keeps the in-use entry and drops stale.
    touch(manager, 'live', 3);
    const before = manager.peek('live');
    const admitted = await manager.admit(entry('incoming', 200, { payload: { tensor: 'new' } }));
    expect(admitted.admitted).toBe(true);
    expect(admitted.evicted.map((e) => e.id)).toContain('stale');
    expect(manager.peek('stale')).toBeUndefined();
    const after = manager.peek('live');
    expect(after?.payload).toEqual(before?.payload);
    expect(after?.bytes).toBe(100);
    expect(manager.get('live').entry?.payload).toEqual({ tensor: 'keep-me' });
    expect(manager.stats().usedBytes).toBeLessThanOrEqual(300);
  });

  it('does not evict a pinned entry, and a rejected admit leaves state unchanged', async () => {
    const manager = createMemoryManager({ byteBudget: 200, strategy: lruStrategy(), storageBudgetBytes: 0 });
    await manager.admit(entry('pinned', 150, { payload: { ok: true } }), { pin: true });
    const before = manager.peek('pinned');
    const rejected = await manager.admit(entry('nope', 100, { payload: { ok: false } }));
    expect(rejected.admitted).toBe(false);
    expect(rejected.evicted).toHaveLength(0);
    expect(manager.peek('pinned')).toEqual(before);
    expect(manager.residentIds()).toEqual(['pinned']);
    expect(manager.stats().usedBytes).toBe(150);
  });

  it('enforces a per-component quota before the global budget', async () => {
    const manager = createMemoryManager({
      byteBudget: 10_000,
      strategy: lruStrategy(),
      storageBudgetBytes: 0,
      quotas: [{ group: 'm', component: 'layer', byteCap: 200 }],
    });
    await manager.admit(entry('L0', 100, { group: 'm', component: 'layer' }));
    await manager.admit(entry('L1', 100, { group: 'm', component: 'layer' }));
    const third = await manager.admit(entry('L2', 100, { group: 'm', component: 'layer' }));
    expect(third.admitted).toBe(true);
    expect(third.evicted.length).toBeGreaterThan(0);
    const layerResidents = manager.residentIds().filter((id) => id.startsWith('L'));
    expect(layerResidents.length).toBe(2);
    expect(manager.stats().usedBytes).toBeLessThanOrEqual(200);
  });

  it('keeps a hot expensive entry under cost-aware eviction', async () => {
    const manager = createMemoryManager({ byteBudget: 200, strategy: costAwareStrategy(), storageBudgetBytes: 0 });
    await manager.admit(entry('precious', 50, { reuseProbability: 1, reloadCostMs: 10_000, payload: { w: 1 } }));
    await manager.admit(entry('cheap', 100, { reuseProbability: 0, reloadCostMs: 1 }));
    const result = await manager.admit(entry('newer', 100, { reuseProbability: 0, reloadCostMs: 1 }));
    expect(result.admitted).toBe(true);
    expect(manager.peek('precious')?.payload).toEqual({ w: 1 });
    expect(result.evicted.map((e) => e.id)).toContain('cheap');
  });

  it('shrinks the workspace under pressure and never crosses the byte budget', async () => {
    const manager = createMemoryManager({
      byteBudget: 1_000,
      strategy: lruStrategy(),
      storageBudgetBytes: 0,
      pressureThreshold: 0.5,
      targetWatermark: 0.4,
      workspace: { minBytes: 50, maxBytes: 400, initialBytes: 400 },
    });
    expect(manager.stats().workspaceBytes).toBe(400);
    await manager.admit(entry('fill', 500));
    expect(manager.stats().usedBytes).toBeLessThanOrEqual(1_000);
    expect(manager.pressure().pressured).toBe(true);
    expect(manager.stats().workspaceBytes).toBeLessThan(400);
    expect(manager.events().some((event) => event.kind === 'workspace-shrink' || event.kind === 'pressure')).toBe(true);
  });

  it('places VRAM only when a VRAM hint is configured', async () => {
    const cpuOnly = createMemoryManager({ byteBudget: 100, vramBudgetBytes: 0, storageBudgetBytes: 0 });
    await cpuOnly.admit(entry('w', 10, { tier: 'vram' }));
    expect(cpuOnly.peek('w')?.tier).toBe('ram');
    const hinted = createMemoryManager({ byteBudget: 100, vramBudgetBytes: 64, storageBudgetBytes: 0 });
    await hinted.admit(entry('w', 10, { tier: 'vram' }));
    expect(hinted.peek('w')?.tier).toBe('vram');
    expect(hinted.pressure().vramBytes).toBe(64);
    expect(hinted.pressure().ramBytes).toBeGreaterThan(0);
  });

  it('reloads a spilled entry from browser storage without corrupting the payload', async () => {
    const sink = createMemorySink();
    const manager = createMemoryManager({
      byteBudget: 100,
      strategy: lruStrategy(),
      storage: sink,
      storageBudgetBytes: 500,
    });
    await manager.admit(entry('cold', 80, { payload: { weights: 'q4-blob' } }));
    const evicted = await manager.admit(entry('hot', 80, { payload: { weights: 'live' } }));
    expect(evicted.evicted.map((e) => e.id)).toContain('cold');
    expect(manager.get('cold').hit).toBe(false);
    const restored = await manager.reload('cold');
    expect(restored.hit).toBe(true);
    expect(restored.entry?.payload).toEqual({ weights: 'q4-blob' });
    expect(manager.stats().reloads).toBe(1);
    expect(manager.stats().usedBytes).toBeLessThanOrEqual(100);
  });

  it('spills through the Phase 1 IndexedDB model cache and reloads the same bytes', async () => {
    const cache = createModelCache({ indexedDB: new IDBFactory() });
    const sink = createModelCacheSink({ cache });
    const manager = createMemoryManager({
      byteBudget: 50,
      strategy: lruStrategy(),
      storage: sink,
      storageBudgetBytes: 200,
    });
    await manager.admit(entry('layer-3', 40, { group: 'tiny', component: 'layer', payload: { rows: [1, 2, 3] } }));
    await manager.admit(entry('layer-4', 40, { group: 'tiny', component: 'layer', payload: { rows: [9] } }));
    expect(manager.get('layer-3').hit).toBe(false);
    expect(await sink.keys()).toContain('layer-3');
    const restored = await manager.reload('layer-3');
    expect(restored.entry?.payload).toEqual({ rows: [1, 2, 3] });
    expect(restored.entry?.group).toBe('tiny');
    // The Phase 1 cache is the store; a memory cache accepts the same sink.
    const memorySink = createModelCacheSink({ cache: createMemoryModelCache() });
    const spilled = await memorySink.spill(entry('solo', 8, { payload: 'hi' }), 1);
    expect((await memorySink.reload(spilled))?.payload).toBe('hi');
  });
});

describe('environment probes', () => {
  it('reports RAM and storage facts without throwing', async () => {
    expect(probeRamBytes()).toBeGreaterThan(0);
    expect(await probeStorageQuotaBytes()).toBeGreaterThanOrEqual(0);
  });
});
