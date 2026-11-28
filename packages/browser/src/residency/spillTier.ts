/**
 * Phase 3 — the browser-storage spill tier of the residency manager.
 *
 * Owns the in-memory spill index (what is retained in the storage sink and how
 * many bytes it holds) and every write to / delete from the sink. The index is
 * the bound: `bytes()` never exceeds the storage budget, even under concurrent
 * spills, because bytes are RESERVED synchronously before the sink write is
 * awaited and released when it settles.
 *
 * Storage is best-effort: a failed delete never resurrects an index entry, and
 * a failed write leaves nothing charged.
 */

import type { SpilledRecord, StorageSink } from './storageSink.js';
import type { ResidentEntry } from './types.js';

export interface SpillTierOptions {
  storage?: StorageSink;
  /** Cap on bytes retained in storage. 0 disables retention. */
  budgetBytes: number;
  now: () => number;
  /** Called once per successful spill (for the manager's event log). */
  onSpill(entry: ResidentEntry, reason: string): void;
}

export interface SpillTier {
  /** True when a sink is configured and the storage budget allows retention. */
  readonly enabled: boolean;
  get(id: string): SpilledRecord | undefined;
  has(id: string): boolean;
  readonly count: number;
  /** Bytes committed in storage (reservations in flight are not included). */
  bytes(): number;
  /** Retain an entry in storage, trimming the oldest spills to make room. */
  retain(entry: ResidentEntry, reason: string): Promise<boolean>;
  /**
   * Drop a spill. The index entry is removed synchronously (before the first
   * await); the sink delete is best-effort. Returns whether a spill existed.
   */
  forget(id: string): Promise<boolean>;
  /**
   * Read a spill back from storage as a RAM-tier entry charged at the spilled
   * footprint. Undefined (and the index entry dropped) when storage lost it.
   */
  reload(id: string): Promise<ResidentEntry | undefined>;
}

/** Storage budget: explicit > 0, else the quota hint, else 4× the RAM budget. `0` disables. */
export function resolveStorageBudget(
  configured: number | undefined,
  storageQuotaBytes: number,
  byteBudget: number,
): number {
  if (configured === 0) return 0;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  if (storageQuotaBytes > 0) return storageQuotaBytes;
  return byteBudget * 4;
}

export function createSpillTier(options: SpillTierOptions): SpillTier {
  const { storage, budgetBytes } = options;
  const enabled = storage !== undefined && budgetBytes > 0;
  const index = new Map<string, SpilledRecord>();
  let committed = 0;
  let reserved = 0;

  function setIndex(record: SpilledRecord): void {
    removeIndex(record.id);
    index.set(record.id, record);
    committed += record.bytes;
  }

  function removeIndex(id: string): SpilledRecord | undefined {
    const record = index.get(id);
    if (!record) return undefined;
    index.delete(id);
    committed -= record.bytes;
    return record;
  }

  async function deleteQuietly(record: SpilledRecord): Promise<void> {
    try {
      await storage?.delete(record);
    } catch {
      // Storage is best-effort. The in-memory spill index is the bound.
    }
  }

  function fits(incomingBytes: number): boolean {
    return committed + reserved + incomingBytes <= budgetBytes;
  }

  async function trim(incomingBytes: number): Promise<void> {
    const ordered = [...index.values()].sort((a, b) => a.spilledAt - b.spilledAt || a.id.localeCompare(b.id));
    for (const oldest of ordered) {
      if (fits(incomingBytes)) return;
      // A concurrent call may already have dropped or replaced this record.
      if (index.get(oldest.id) !== oldest) continue;
      removeIndex(oldest.id);
      await deleteQuietly(oldest);
    }
  }

  return {
    enabled,
    get: (id) => index.get(id),
    has: (id) => index.has(id),
    get count() {
      return index.size;
    },
    bytes: () => committed,

    async retain(entry, reason) {
      if (!enabled || !storage) return false;
      if (!(entry.bytes >= 0) || entry.bytes > budgetBytes) return false;
      const previous = removeIndex(entry.id);
      // Replacing a spill; a failed delete must not block the new write.
      if (previous) await deleteQuietly(previous);
      await trim(entry.bytes);
      // Check and reserve in the same synchronous step: a concurrent retain
      // awaiting its own write can no longer push storage past the budget.
      if (!fits(entry.bytes)) return false;
      reserved += entry.bytes;
      try {
        const stored = await storage.spill({ ...entry, tier: 'storage' }, options.now());
        setIndex(stored);
        options.onSpill(entry, reason);
        return true;
      } catch {
        return false;
      } finally {
        reserved -= entry.bytes;
      }
    },

    async forget(id) {
      const record = removeIndex(id);
      if (!record) return false;
      await deleteQuietly(record);
      return true;
    },

    async reload(id) {
      const record = index.get(id);
      if (!record || !storage) return undefined;
      let restored: ResidentEntry | undefined;
      try {
        restored = await storage.reload(record);
      } catch {
        restored = undefined;
      }
      if (!restored) {
        if (index.get(id) === record) removeIndex(id);
        return undefined;
      }
      return { ...restored, id, tier: 'ram', bytes: record.bytes };
    },
  };
}
