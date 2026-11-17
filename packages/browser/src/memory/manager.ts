/**
 * Phase 3 — residency manager.
 *
 * Admits model weights and per-layer components into a hard byte budget,
 * evicts with an injected strategy when the budget (or a quota) would be
 * exceeded, spills cold entries to a browser-storage sink, and grows or
 * shrinks a workspace under pressure.
 *
 * Decoupled from execution: nothing here calls an inference backend or decides
 * when to run. The controller reads `pressure()` / `stats()` if it wants a
 * residency hint; this module never calls the controller.
 *
 * Invariants:
 *   - `stats().usedBytes <= config.byteBudget` after every public call.
 *   - Eviction is transactional: entries are dropped only once the admission
 *     is known to fit. A rejected admission leaves every resident untouched.
 *   - Eviction drops whole entries. It never mutates another entry's payload,
 *     so an in-use entry stays consistent.
 *   - Pinned entries are never evicted. An admission that cannot fit even
 *     after evicting every unpinned resident is spilled (when a sink and a
 *     storage budget allow) or rejected — it is never allowed to exceed the
 *     RAM budget.
 *   - Spilled bytes (including concurrent spills), strategy ghost state, and
 *     the event log are all bounded.
 *
 * The concerns live in their own modules: victims.ts (victim selection +
 * quota accounting), spillTier.ts (the storage tier), workspace.ts (the
 * dynamic workspace), envProbe.ts (RAM / storage facts).
 */

import type {
  EvictionStrategy,
  MemoryPressure,
  ResidencyEvent,
  ResidentEntry,
  TrackedEntry,
} from './types.js';
import { probeRamBytes } from './envProbe.js';
import { costAwareStrategy } from './eviction.js';
import type { AdmitResult, MemoryManager, MemoryManagerOptions } from './managerTypes.js';
import { detectPressure } from './pressure.js';
import { createSpillTier, resolveStorageBudget } from './spillTier.js';
import { selectVictims } from './victims.js';
import { createWorkspaceController } from './workspace.js';

export { probeRamBytes, probeStorageQuotaBytes } from './envProbe.js';
export type { AdmitResult, MemoryManager, MemoryManagerOptions } from './managerTypes.js';

const DEFAULT_PRESSURE = 0.85;
const DEFAULT_WATERMARK = 0.7;
const DEFAULT_EVENT_LIMIT = 256;

export function createMemoryManager(options: MemoryManagerOptions): MemoryManager {
  if (!(options.byteBudget > 0) || !Number.isFinite(options.byteBudget)) {
    throw new Error('createMemoryManager: byteBudget must be a finite number > 0');
  }
  const byteBudget = options.byteBudget;
  const strategy: EvictionStrategy = options.strategy ?? costAwareStrategy();
  const pressureThreshold = options.pressureThreshold ?? DEFAULT_PRESSURE;
  const targetWatermark = Math.min(pressureThreshold, options.targetWatermark ?? DEFAULT_WATERMARK);
  const eventLogLimit = options.eventLogLimit ?? DEFAULT_EVENT_LIMIT;
  const now = options.now ?? (() => Date.now());
  const ramBytes = options.ramBytes ?? probeRamBytes();
  const vramBytes = Math.max(0, options.vramBudgetBytes ?? 0);
  const storageQuotaBytes = options.storageQuotaBytes ?? 0;
  const quotas = options.quotas ?? [];

  const residents = new Map<string, TrackedEntry>();
  const log: ResidencyEvent[] = [];
  let residentTotal = 0;
  let seq = 0;
  let hits = 0;
  let misses = 0;
  let admissions = 0;
  let evictions = 0;
  let spills = 0;
  let reloads = 0;

  const spill = createSpillTier({
    storage: options.storage,
    budgetBytes: resolveStorageBudget(options.storageBudgetBytes, storageQuotaBytes, byteBudget),
    now,
    onSpill(entry, reason) {
      spills += 1;
      record({ kind: 'spill', id: entry.id, bytes: entry.bytes, reason });
    },
  });
  const workspace = createWorkspaceController({
    bounds: {
      minBytes: Math.max(0, options.workspace?.minBytes ?? 0),
      maxBytes: Math.max(0, options.workspace?.maxBytes ?? 0),
    },
    byteBudget,
    initialBytes: options.workspace?.initialBytes,
  });

  function putResident(entry: TrackedEntry): void {
    const previous = residents.get(entry.id);
    if (previous) residentTotal -= previous.bytes;
    residents.set(entry.id, entry);
    residentTotal += entry.bytes;
  }

  function removeResident(id: string): void {
    const previous = residents.get(id);
    if (!previous) return;
    residents.delete(id);
    residentTotal -= previous.bytes;
  }

  function usedBytes(): number {
    return residentTotal + workspace.bytes();
  }

  function record(event: Omit<ResidencyEvent, 'at'>): void {
    log.push({ ...event, at: now() });
    if (log.length > eventLogLimit) log.splice(0, log.length - eventLogLimit);
  }

  function pressureNow(): MemoryPressure {
    return detectPressure({
      usedBytes: usedBytes(),
      byteBudget,
      pressureThreshold,
      targetWatermark,
      ramBytes,
      vramBytes,
      storageQuotaBytes,
    });
  }

  function applyWorkspace(onHit: boolean): void {
    const change = workspace.apply({ onHit, pressure: pressureNow(), residentBytes: residentTotal });
    if (change) record(change);
  }

  function drop(entry: TrackedEntry, reason: string): void {
    removeResident(entry.id);
    evictions += 1;
    strategy.observe?.({ kind: 'evict', entry });
    record({ kind: 'evict', id: entry.id, bytes: entry.bytes, reason });
  }

  function placeTier(entry: ResidentEntry): ResidentEntry['tier'] {
    // VRAM is a hint. Only place there when a budget was configured and the
    // caller asked for it. CPU-only (vramBudgetBytes = 0) always stays in RAM.
    if (entry.tier === 'vram' && vramBytes > 0) return 'vram';
    return 'ram';
  }

  function rate(): number {
    const total = hits + misses;
    return total === 0 ? 0 : hits / total;
  }

  function notAdmitted(spilledOk: boolean, spilledReason: string, rejectedReason: string): AdmitResult {
    return {
      admitted: false,
      spilled: spilledOk,
      replaced: false,
      evicted: [],
      reason: spilledOk ? spilledReason : rejectedReason,
    };
  }

  const manager: MemoryManager = {
    async admit(entry, admitOptions) {
      if (!(entry.bytes >= 0) || !Number.isFinite(entry.bytes)) {
        return { admitted: false, spilled: false, replaced: false, evicted: [], reason: 'invalid footprint' };
      }
      const wantSpill = admitOptions?.spill !== false && spill.enabled;

      if (entry.bytes > byteBudget) {
        const spilledOk = wantSpill && await spill.retain(entry, 'entry exceeds the hard byte budget');
        return notAdmitted(spilledOk, 'spilled: entry larger than byte budget', 'rejected: entry larger than byte budget');
      }

      const existing = residents.get(entry.id);
      const except = new Set<string>();
      if (existing) except.add(existing.id);
      const victims = selectVictims({
        incoming: entry,
        residents: residents.values(),
        except,
        strategy,
        quotas,
        byteBudget,
        workspaceBytes: workspace.bytes(),
      });
      if (!victims) {
        // Nothing was dropped. Spill or reject, leaving every resident intact.
        const spilledOk = wantSpill && await spill.retain(entry, 'pinned residents fill the budget');
        return notAdmitted(spilledOk, 'spilled: budget held by pinned residents', 'rejected: budget held by pinned residents');
      }

      // RAM mutations are synchronous and finish before any storage await, so a
      // second admit cannot observe a half-applied eviction or an over-budget map.
      const spilledVictims: TrackedEntry[] = [];
      for (const victim of victims) {
        const live = residents.get(victim.id);
        if (!live) continue;
        drop(live, `make room for ${entry.id}`);
        spilledVictims.push(live);
      }
      if (existing) removeResident(existing.id);

      const tick = ++seq;
      const tracked: TrackedEntry = {
        ...entry,
        tier: placeTier(entry),
        pinned: admitOptions?.pin === true || entry.pinned === true,
        admittedAt: existing?.admittedAt ?? tick,
        lastUsedAt: tick,
        hits: 0,
        arcList: 't1',
      };
      putResident(tracked);
      // The index entry is dropped synchronously; the sink delete is awaited below.
      const forgettingPriorSpill = spill.forget(entry.id);
      admissions += 1;
      strategy.observe?.({ kind: 'admit', entry: tracked });
      record({
        kind: 'admit',
        id: entry.id,
        bytes: entry.bytes,
        reason: victims.length > 0 ? `admitted after evicting ${victims.length}` : 'admitted within budget',
      });

      await forgettingPriorSpill;
      if (wantSpill) {
        for (const live of spilledVictims) {
          await spill.retain(live, `evicted to make room for ${entry.id}`);
        }
      }

      const reading = pressureNow();
      if (reading.pressured) {
        record({
          kind: 'pressure',
          bytes: reading.reclaimBytes,
          reason: `utilization ${(reading.utilization * 100).toFixed(1)}%`,
        });
        applyWorkspace(false);
      }

      return {
        admitted: true,
        spilled: false,
        replaced: existing !== undefined,
        evicted: victims,
        reason: victims.length > 0 ? `evicted ${victims.length} to fit` : 'fit within budget',
      };
    },

    get(id) {
      const entry = residents.get(id);
      if (!entry) {
        misses += 1;
        const spilled = spill.get(id);
        const ghost: TrackedEntry = {
          id,
          group: spilled?.group ?? '',
          component: spilled?.component,
          bytes: spilled?.bytes ?? 0,
          reloadCostMs: spilled?.reloadCostMs ?? 0,
          reuseProbability: spilled?.reuseProbability ?? 0,
          tier: 'storage',
          admittedAt: 0,
          lastUsedAt: 0,
          hits: 0,
        };
        strategy.observe?.({ kind: 'miss', entry: ghost });
        record({ kind: 'miss', id, reason: spilled ? 'miss: spilled to storage' : 'miss: not resident' });
        return { hit: false };
      }
      const tick = ++seq;
      const touched: TrackedEntry = {
        ...entry,
        lastUsedAt: tick,
        hits: entry.hits + 1,
        arcList: entry.hits + 1 > 1 ? 't2' : 't1',
      };
      putResident(touched);
      hits += 1;
      strategy.observe?.({ kind: 'hit', entry: touched });
      record({ kind: 'hit', id, reason: `hit #${touched.hits}` });
      applyWorkspace(true);
      return { hit: true, entry: snapshot(touched) };
    },

    hitRate() {
      return rate();
    },

    async reload(id) {
      const already = residents.get(id);
      if (already) return { hit: true, entry: snapshot(already) };
      const restored = spill.has(id) ? await spill.reload(id) : undefined;
      if (!restored) {
        misses += 1;
        return { hit: false };
      }
      const result = await manager.admit(restored, { spill: false });
      if (!result.admitted) {
        misses += 1;
        return { hit: false };
      }
      reloads += 1;
      record({ kind: 'reload', id, reason: 'reloaded from browser storage' });
      const entry = residents.get(id);
      return entry ? { hit: true, entry: snapshot(entry) } : { hit: false };
    },

    pin(id) {
      const entry = residents.get(id);
      if (!entry) return false;
      putResident({ ...entry, pinned: true });
      record({ kind: 'pin', id, reason: 'pinned' });
      return true;
    },

    unpin(id) {
      const entry = residents.get(id);
      if (!entry) return false;
      putResident({ ...entry, pinned: false });
      record({ kind: 'unpin', id, reason: 'unpinned' });
      return true;
    },

    async release(id) {
      const entry = residents.get(id);
      if (entry) {
        drop(entry, 'released');
        return true;
      }
      return spill.forget(id);
    },

    pressure() {
      return pressureNow();
    },

    stats() {
      return {
        hits,
        misses,
        admissions,
        evictions,
        spills,
        reloads,
        usedBytes: usedBytes(),
        byteBudget,
        workspaceBytes: workspace.bytes(),
        residentCount: residents.size,
        spilledCount: spill.count,
        spilledBytes: spill.bytes(),
        hitRate: rate(),
      };
    },

    events() {
      return log;
    },

    residentIds() {
      return [...residents.keys()];
    },

    peek(id) {
      const entry = residents.get(id);
      return entry ? snapshot(entry) : undefined;
    },
  };

  return manager;
}

function snapshot(entry: TrackedEntry): TrackedEntry {
  return { ...entry };
}
