/**
 * Phase 4 — the prefetcher's budgeted resident store.
 *
 * Holds every value the prefetcher has loaded — speculative prefetches AND
 * demand loads, claimed or not — inside a byte budget and an entry cap. When
 * either is exceeded the store evicts in two passes:
 *   1. unclaimed speculative prefetches, oldest first (pure waste so far);
 *   2. everything else, least recently used first.
 * So nothing the prefetcher loads can pin memory forever.
 *
 * Recency is the Map's insertion order: a touch deletes and re-inserts.
 */

export interface ResidentValue {
  value: unknown;
  bytes: number;
  loadedAt: number;
  loadMs: number;
  /** 'prefetch' when the data was loaded speculatively, 'demand' otherwise. */
  source: 'prefetch' | 'demand';
  /** True when a request consumed the loaded data. */
  claimed: boolean;
}

export interface ResidentStoreOptions {
  /** Byte budget over every resident value. `Infinity` = no byte bound. */
  budgetBytes: number;
  /** Entry cap over every resident value. */
  maxEntries: number;
}

export interface ResidentStore {
  /** Read and mark most recently used. */
  get(id: string): ResidentValue | undefined;
  /** Read without touching recency. */
  peek(id: string): ResidentValue | undefined;
  has(id: string): boolean;
  /** Insert (or replace) a value, then evict until inside the budget. */
  set(id: string, value: ResidentValue): void;
  /** Drop one value. Returns whether something was dropped. */
  delete(id: string): boolean;
  /** Mark a value claimed by a request. */
  markClaimed(id: string): void;
  /** Drop every unclaimed speculative prefetch. Returns how many were dropped. */
  releaseUnclaimed(): number;
  /** Evict until inside the budget and the entry cap. */
  enforce(): void;
  bytes(): number;
  ids(): string[];
}

function isUnclaimedPrefetch(entry: ResidentValue): boolean {
  return entry.source === 'prefetch' && !entry.claimed;
}

export function createResidentStore(options: ResidentStoreOptions): ResidentStore {
  const entries = new Map<string, ResidentValue>();
  const maxEntries = Math.max(1, options.maxEntries);
  let used = 0;

  function over(): boolean {
    return used > options.budgetBytes || entries.size > maxEntries;
  }

  function remove(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    used -= entry.bytes;
    return true;
  }

  function enforce(): void {
    if (!over()) return;
    for (const [id, entry] of [...entries]) {
      if (!over()) return;
      if (isUnclaimedPrefetch(entry)) remove(id);
    }
    for (const id of [...entries.keys()]) {
      if (!over()) return;
      remove(id);
    }
  }

  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      entries.delete(id);
      entries.set(id, entry);
      return entry;
    },
    peek: (id) => entries.get(id),
    has: (id) => entries.has(id),
    set(id, value) {
      remove(id);
      // A bogus footprint must not poison the running total.
      if (!(Number.isFinite(value.bytes) && value.bytes > 0)) value.bytes = 0;
      entries.set(id, value);
      used += value.bytes;
      enforce();
    },
    delete: remove,
    markClaimed(id) {
      const entry = entries.get(id);
      if (entry) entry.claimed = true;
    },
    releaseUnclaimed() {
      let released = 0;
      for (const [id, entry] of [...entries]) {
        if (!isUnclaimedPrefetch(entry)) continue;
        remove(id);
        released += 1;
      }
      return released;
    },
    enforce,
    bytes: () => used,
    ids: () => [...entries.keys()],
  };
}
