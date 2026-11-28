/**
 * Phase 3 — pluggable eviction strategies.
 *
 * Each strategy ranks evictable residents from most-evictable to least.
 * The manager walks that order until the byte budget (and quotas) fit.
 * Strategies never mutate the manager's map, so they are swappable in tests.
 *
 * Cost-aware is the default: it evicts the entry with the worst
 * (reuseProbability * reloadCostMs) / footprint score first — a large, cold,
 * cheap-to-reload entry leaves before a small, hot, expensive one.
 */

import type { EvictionStrategy, TrackedEntry } from './types.js';

function byNumber(pick: (entry: TrackedEntry) => number, direction: 'asc' | 'desc'): (a: TrackedEntry, b: TrackedEntry) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const delta = pick(a) - pick(b);
    if (delta !== 0) return sign * delta;
    // Stable tie-break: older admission leaves first.
    return a.admittedAt - b.admittedAt;
  };
}

/** Least-recently-used. Evicts the entry with the oldest `lastUsedAt` first. */
export function lruStrategy(): EvictionStrategy {
  return {
    name: 'lru',
    rank(candidates) {
      return [...candidates].sort(byNumber((e) => e.lastUsedAt, 'asc'));
    },
  };
}

/** Least-frequently-used. Evicts the entry with the fewest hits first. */
export function lfuStrategy(): EvictionStrategy {
  return {
    name: 'lfu',
    rank(candidates) {
      return [...candidates].sort(byNumber((e) => e.hits, 'asc'));
    },
  };
}

/**
 * Value of keeping an entry, per byte. Higher means "keep".
 * `reuseProbability * reloadCostMs` is the expected reload penalty of evicting
 * it; dividing by footprint prefers dropping large cold entries.
 * A zero-byte entry is treated as infinitely cheap to keep (never preferred).
 */
export function retentionValue(entry: TrackedEntry): number {
  const footprint = entry.bytes > 0 ? entry.bytes : 1;
  const expectedReload = clamp01(entry.reuseProbability) * Math.max(0, entry.reloadCostMs);
  return expectedReload / footprint;
}

/** Cost-aware. Evicts the lowest retention-value-per-byte entry first. */
export function costAwareStrategy(): EvictionStrategy {
  return {
    name: 'cost-aware',
    rank(candidates) {
      return [...candidates].sort(byNumber((e) => retentionValue(e), 'asc'));
    },
  };
}

/**
 * Adaptive Replacement Cache (Megiddo & Modha).
 *
 * Maintains four logical lists over the manager's tracked entries plus two
 * ghost lists of recently evicted ids:
 *   T1 recent residents, T2 frequent residents,
 *   B1 ghost of evicted-once, B2 ghost of evicted-frequent.
 * A hit on B1 grows the T1 target (recency is winning); a hit on B2 shrinks it
 * (frequency is winning). Ranking evicts from the list that is over its target.
 *
 * Ghost ids are bounded by `ghostCapacity` (default 1024) so a sustained
 * workload cannot grow strategy state without bound.
 */
export function arcStrategy(ghostCapacity = 1024): EvictionStrategy {
  const b1: string[] = [];
  const b2: string[] = [];
  let p = 0;

  const remember = (list: string[], id: string) => {
    const existing = list.indexOf(id);
    if (existing >= 0) list.splice(existing, 1);
    list.push(id);
    while (list.length > ghostCapacity) list.shift();
  };
  const forget = (list: string[], id: string): boolean => {
    const existing = list.indexOf(id);
    if (existing < 0) return false;
    list.splice(existing, 1);
    return true;
  };

  return {
    name: 'arc',
    observe(event) {
      const id = event.entry.id;
      if (event.kind === 'miss') {
        // A miss that was recently evicted adapts the target.
        if (forget(b1, id)) p = Math.min(ghostCapacity, p + Math.max(1, b2.length / Math.max(1, b1.length + 1)));
        else if (forget(b2, id)) p = Math.max(0, p - Math.max(1, b1.length / Math.max(1, b2.length + 1)));
        return;
      }
      if (event.kind === 'evict') {
        if (event.entry.arcList === 't2' || event.entry.hits > 1) remember(b2, id);
        else remember(b1, id);
      }
    },
    rank(candidates) {
      const t1 = candidates.filter((e) => (e.arcList ?? (e.hits <= 1 ? 't1' : 't2')) === 't1');
      const t2 = candidates.filter((e) => (e.arcList ?? (e.hits <= 1 ? 't1' : 't2')) === 't2');
      // Evict from whichever list is over its target. p is the T1 target.
      const evictT1First = t1.length >= p || t2.length === 0;
      const primary = evictT1First ? t1 : t2;
      const secondary = evictT1First ? t2 : t1;
      const order = byNumber((e) => e.lastUsedAt, 'asc');
      return [...primary].sort(order).concat([...secondary].sort(order));
    },
  };
}

/** Resolve a strategy by name. Unknown names fall back to cost-aware. */
export function strategyByName(name: EvictionStrategy['name']): EvictionStrategy {
  switch (name) {
    case 'lru':
      return lruStrategy();
    case 'lfu':
      return lfuStrategy();
    case 'arc':
      return arcStrategy();
    case 'cost-aware':
      return costAwareStrategy();
    default:
      return costAwareStrategy();
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
