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
 *   - Spilled bytes, strategy ghost state, and the event log are all bounded.
 */

import type {
  AdmitOptions,
  EvictionStrategy,
  LookupResult,
  MemoryManagerConfig,
  MemoryPressure,
  Quota,
  ResidencyEvent,
  ResidencyStats,
  ResidentEntry,
  TrackedEntry,
} from './types.js';
import { costAwareStrategy } from './eviction.js';
import { detectPressure, planWorkspace, type WorkspaceBounds } from './pressure.js';
import type { SpilledRecord, StorageSink } from './storageSink.js';

export interface MemoryManager {
  /** Admit an entry, evicting or spilling as needed to honor the hard budget. */
  admit(entry: ResidentEntry, options?: AdmitOptions): Promise<AdmitResult>;
  /** Touch an entry. A hit updates recency and frequency and may grow the workspace. */
  get(id: string): LookupResult;
  /** hits / (hits + misses). 0 before the first lookup. */
  hitRate(): number;
  /** Reload a spilled entry back into RAM, charging the budget. */
  reload(id: string): Promise<LookupResult>;
  /** Pin an entry so eviction cannot drop it. */
  pin(id: string): boolean;
  /** Release a pin. */
  unpin(id: string): boolean;
  /** Drop one entry. Returns true if it was resident or spilled. */
  release(id: string): Promise<boolean>;
  /** Current pressure reading. */
  pressure(): MemoryPressure;
  /** Aggregate counters, including `hitRate`. */
  stats(): ResidencyStats;
  /** Explainable event log, oldest first, bounded by `eventLogLimit`. */
  events(): readonly ResidencyEvent[];
  /** Ids currently charged against the budget. */
  residentIds(): string[];
  /** Snapshot of one resident, for tests asserting eviction did not corrupt it. */
  peek(id: string): TrackedEntry | undefined;
}

export interface AdmitResult {
  /** True when the entry is now charged against the RAM/VRAM budget. */
  admitted: boolean;
  /** True when the incoming entry was spilled to browser storage instead. */
  spilled: boolean;
  /** True when a same-id resident was replaced. */
  replaced: boolean;
  /** Entries evicted to make room, oldest-evicted first. Snapshots, not live refs. */
  evicted: TrackedEntry[];
  reason: string;
}

export interface MemoryManagerOptions extends MemoryManagerConfig {
  /** Spill sink. Required for storage residency; omit for a RAM-only manager. */
  storage?: StorageSink;
}

const DEFAULT_PRESSURE = 0.85;
const DEFAULT_WATERMARK = 0.7;
const DEFAULT_EVENT_LIMIT = 256;
const DEFAULT_RAM_BYTES = 4 * 1024 * 1024 * 1024;

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
  const storageBudgetBytes = resolveStorageBudget(options.storageBudgetBytes, storageQuotaBytes, byteBudget);
  const quotas = options.quotas ?? [];
  const storage = options.storage;
  const bounds: WorkspaceBounds = {
    minBytes: Math.max(0, options.workspace?.minBytes ?? 0),
    maxBytes: Math.max(0, options.workspace?.maxBytes ?? 0),
  };

  const residents = new Map<string, TrackedEntry>();
  const spilled = new Map<string, SpilledRecord>();
  const log: ResidencyEvent[] = [];
  let seq = 0;
  let hits = 0;
  let misses = 0;
  let admissions = 0;
  let evictions = 0;
  let spills = 0;
  let reloads = 0;
  let workspaceBytes = clampWorkspace(options.workspace?.initialBytes ?? bounds.minBytes);

  function clampWorkspace(bytes: number): number {
    if (bounds.maxBytes <= 0 && bounds.minBytes <= 0) return 0;
    // The workspace is charged against the hard budget, so it can never start
    // (or grow) past it — even if the caller asked for a larger floor.
    const cap = Math.min(bounds.maxBytes, byteBudget);
    const floor = Math.min(bounds.minBytes, cap);
    const value = Number.isFinite(bytes) ? bytes : floor;
    return Math.min(cap, Math.max(floor, value));
  }

  function residentBytes(except: ReadonlySet<string>): number {
    let total = 0;
    for (const entry of residents.values()) {
      if (except.has(entry.id)) continue;
      total += entry.bytes;
    }
    return total;
  }

  function usedBytes(): number {
    return residentBytes(new Set()) + workspaceBytes;
  }

  function spilledBytes(): number {
    let total = 0;
    for (const record of spilled.values()) total += record.bytes;
    return total;
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

  function quotaApplies(quota: Quota, entry: ResidentEntry): boolean {
    if (quota.group !== entry.group) return false;
    if (quota.component !== undefined && quota.component !== entry.component) return false;
    return true;
  }

  function fits(incoming: ResidentEntry, except: ReadonlySet<string>): boolean {
    if (residentBytes(except) + workspaceBytes + incoming.bytes > byteBudget) return false;
    for (const quota of quotas) {
      if (!quotaApplies(quota, incoming)) continue;
      let used = 0;
      for (const entry of residents.values()) {
        if (except.has(entry.id)) continue;
        if (entry.group !== quota.group) continue;
        if (quota.component !== undefined && entry.component !== quota.component) continue;
        used += entry.bytes;
      }
      if (used + incoming.bytes > quota.byteCap) return false;
    }
    return true;
  }

  function evictable(except: ReadonlySet<string>): TrackedEntry[] {
    const out: TrackedEntry[] = [];
    for (const entry of residents.values()) {
      if (entry.pinned) continue;
      if (except.has(entry.id)) continue;
      out.push(entry);
    }
    return out;
  }

  /**
   * Choose victims without mutating. `except` bytes are treated as already
   * gone (the entry being replaced). Returns undefined when no subset of
   * unpinned residents makes the admission fit — callers must then leave the
   * map unchanged.
   */
  function selectVictims(incoming: ResidentEntry, except: ReadonlySet<string>): TrackedEntry[] | undefined {
    if (fits(incoming, except)) return [];
    const ranked = strategy.rank(evictable(except));
    const sameGroup = ranked.filter((entry) => entry.group === incoming.group);
    const rest = ranked.filter((entry) => entry.group !== incoming.group);
    const chosen: TrackedEntry[] = [];
    const freed = new Set(except);
    for (const candidate of [...sameGroup, ...rest]) {
      if (freed.has(candidate.id)) continue;
      freed.add(candidate.id);
      chosen.push(candidate);
      if (fits(incoming, freed)) return chosen.map(snapshot);
    }
    return undefined;
  }

  function drop(entry: TrackedEntry, reason: string): void {
    residents.delete(entry.id);
    evictions += 1;
    strategy.observe?.({ kind: 'evict', entry });
    record({ kind: 'evict', id: entry.id, bytes: entry.bytes, reason });
  }

  async function trimStorage(incomingBytes: number): Promise<void> {
    if (!storage || storageBudgetBytes <= 0) return;
    const ordered = [...spilled.values()].sort((a, b) => a.spilledAt - b.spilledAt || a.id.localeCompare(b.id));
    for (const oldest of ordered) {
      if (spilledBytes() + incomingBytes <= storageBudgetBytes) return;
      spilled.delete(oldest.id);
      try {
        await storage.delete(oldest);
      } catch {
        // Storage is best-effort. The in-memory spill index is the bound.
      }
    }
  }

  async function retain(entry: ResidentEntry, reason: string): Promise<boolean> {
    if (!storage || storageBudgetBytes <= 0) return false;
    if (!(entry.bytes >= 0) || entry.bytes > storageBudgetBytes) return false;
    const previous = spilled.get(entry.id);
    if (previous) {
      spilled.delete(entry.id);
      try {
        await storage.delete(previous);
      } catch {
        // Replacing a spill; a failed delete must not block the new write.
      }
    }
    await trimStorage(entry.bytes);
    if (spilledBytes() + entry.bytes > storageBudgetBytes) return false;
    try {
      const stored = await storage.spill({ ...entry, tier: 'storage' }, now());
      spilled.set(entry.id, stored);
      spills += 1;
      record({ kind: 'spill', id: entry.id, bytes: entry.bytes, reason });
      return true;
    } catch {
      return false;
    }
  }

  function placeTier(entry: ResidentEntry): ResidentEntry['tier'] {
    // VRAM is a hint. Only place there when a budget was configured and the
    // caller asked for it. CPU-only (vramBudgetBytes = 0) always stays in RAM.
    if (entry.tier === 'vram' && vramBytes > 0) return 'vram';
    return 'ram';
  }

  function applyWorkspace(onHit: boolean): void {
    if (bounds.maxBytes <= 0 && bounds.minBytes <= 0) return;
    const decision = planWorkspace({
      currentBytes: workspaceBytes,
      bounds,
      pressure: pressureNow(),
      byteBudget,
      usedBytes: usedBytes(),
      onHit,
    });
    if (decision.deltaBytes === 0) return;
    const next = clampWorkspace(decision.nextBytes);
    if (next === workspaceBytes) return;
    // Never let a workspace change push the total over the hard budget.
    const residentsOnly = usedBytes() - workspaceBytes;
    if (residentsOnly + next > byteBudget) return;
    const delta = next - workspaceBytes;
    workspaceBytes = next;
    record({
      kind: delta > 0 ? 'workspace-grow' : 'workspace-shrink',
      bytes: Math.abs(delta),
      reason: decision.reason,
    });
  }

  function rate(): number {
    const total = hits + misses;
    return total === 0 ? 0 : hits / total;
  }

  const manager: MemoryManager = {
    async admit(entry, admitOptions) {
      if (!(entry.bytes >= 0) || !Number.isFinite(entry.bytes)) {
        return { admitted: false, spilled: false, replaced: false, evicted: [], reason: 'invalid footprint' };
      }
      const wantSpill = admitOptions?.spill !== false && storage !== undefined && storageBudgetBytes > 0;

      if (entry.bytes > byteBudget) {
        const spilledOk = wantSpill && await retain(entry, 'entry exceeds the hard byte budget');
        return {
          admitted: false,
          spilled: spilledOk,
          replaced: false,
          evicted: [],
          reason: spilledOk ? 'spilled: entry larger than byte budget' : 'rejected: entry larger than byte budget',
        };
      }

      const existing = residents.get(entry.id);
      const except = new Set<string>();
      if (existing) except.add(existing.id);
      const victims = selectVictims(entry, except);
      if (!victims) {
        // Nothing was dropped. Spill or reject, leaving every resident intact.
        const spilledOk = wantSpill && await retain(entry, 'pinned residents fill the budget');
        return {
          admitted: false,
          spilled: spilledOk,
          replaced: false,
          evicted: [],
          reason: spilledOk ? 'spilled: budget held by pinned residents' : 'rejected: budget held by pinned residents',
        };
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
      if (existing && residents.has(existing.id)) residents.delete(existing.id);

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
      residents.set(entry.id, tracked);
      const priorSpill = spilled.get(entry.id);
      if (priorSpill) spilled.delete(entry.id);
      admissions += 1;
      strategy.observe?.({ kind: 'admit', entry: tracked });
      record({
        kind: 'admit',
        id: entry.id,
        bytes: entry.bytes,
        reason: victims.length > 0 ? `admitted after evicting ${victims.length}` : 'admitted within budget',
      });

      if (priorSpill) {
        try {
          await storage?.delete(priorSpill);
        } catch {
          // The index no longer charges these bytes. A failed delete cannot resurrect them.
        }
      }
      if (wantSpill) {
        for (const live of spilledVictims) {
          await retain(live, `evicted to make room for ${entry.id}`);
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
        const spill = spilled.get(id);
        const ghost: TrackedEntry = {
          id,
          group: spill?.group ?? '',
          component: spill?.component,
          bytes: spill?.bytes ?? 0,
          reloadCostMs: spill?.reloadCostMs ?? 0,
          reuseProbability: spill?.reuseProbability ?? 0,
          tier: 'storage',
          admittedAt: 0,
          lastUsedAt: 0,
          hits: 0,
        };
        strategy.observe?.({ kind: 'miss', entry: ghost });
        record({ kind: 'miss', id, reason: spill ? 'miss: spilled to storage' : 'miss: not resident' });
        return { hit: false };
      }
      const tick = ++seq;
      const touched: TrackedEntry = {
        ...entry,
        lastUsedAt: tick,
        hits: entry.hits + 1,
        arcList: entry.hits + 1 > 1 ? 't2' : 't1',
      };
      residents.set(id, touched);
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
      const stored = spilled.get(id);
      if (!stored || !storage) {
        misses += 1;
        return { hit: false };
      }
      let restored: ResidentEntry | undefined;
      try {
        restored = await storage.reload(stored);
      } catch {
        restored = undefined;
      }
      if (!restored) {
        misses += 1;
        spilled.delete(id);
        return { hit: false };
      }
      const result = await manager.admit(
        { ...restored, id, tier: 'ram', bytes: stored.bytes },
        { spill: false },
      );
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
      residents.set(id, { ...entry, pinned: true });
      record({ kind: 'pin', id, reason: 'pinned' });
      return true;
    },

    unpin(id) {
      const entry = residents.get(id);
      if (!entry) return false;
      residents.set(id, { ...entry, pinned: false });
      record({ kind: 'unpin', id, reason: 'unpinned' });
      return true;
    },

    async release(id) {
      const entry = residents.get(id);
      if (entry) {
        drop(entry, 'released');
        return true;
      }
      const stored = spilled.get(id);
      if (!stored) return false;
      spilled.delete(id);
      try {
        await storage?.delete(stored);
      } catch {
        // Index already dropped; a failed storage delete cannot resurrect it.
      }
      return true;
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
        workspaceBytes,
        residentCount: residents.size,
        spilledCount: spilled.size,
        spilledBytes: spilledBytes(),
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

function resolveStorageBudget(
  configured: number | undefined,
  storageQuotaBytes: number,
  byteBudget: number,
): number {
  if (configured === 0) return 0;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  if (storageQuotaBytes > 0) return storageQuotaBytes;
  return byteBudget * 4;
}

/** Probe a RAM hint. Fact, not a gate. 4 GiB when the environment has none. */
export function probeRamBytes(): number {
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator;
  const deviceMemory = nav?.deviceMemory;
  if (typeof deviceMemory === 'number' && deviceMemory > 0) return deviceMemory * 1024 * 1024 * 1024;
  return DEFAULT_RAM_BYTES;
}

/**
 * Probe a browser-storage quota hint. Resolves 0 when the Storage API is
 * absent (Node tests, locked-down iframes). Never throws.
 */
export async function probeStorageQuotaBytes(): Promise<number> {
  const nav = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number }> } } }).navigator;
  try {
    const estimate = await nav?.storage?.estimate?.();
    return typeof estimate?.quota === 'number' && estimate.quota > 0 ? estimate.quota : 0;
  } catch {
    return 0;
  }
}
