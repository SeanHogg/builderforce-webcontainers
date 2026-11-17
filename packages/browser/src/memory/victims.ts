/**
 * Phase 3 — victim selection and quota accounting for the residency manager.
 *
 * Pure over the snapshot it is given: it never mutates the residents map, so
 * eviction stays transactional (the manager drops victims only once the
 * admission is known to fit).
 *
 * Cost: usage is computed ONCE per selection — the global total plus one
 * running sum per quota that applies to the incoming entry — and each chosen
 * candidate is subtracted incrementally. A selection is O(n · q) plus the
 * strategy's rank, not O(n² · q).
 */

import type { EvictionStrategy, Quota, ResidentEntry, TrackedEntry } from './types.js';

/** True when `quota` charges `entry` (same group, and same component when the quota names one). */
export function quotaApplies(quota: Quota, entry: Pick<ResidentEntry, 'group' | 'component'>): boolean {
  if (quota.group !== entry.group) return false;
  if (quota.component !== undefined && quota.component !== entry.component) return false;
  return true;
}

export interface VictimQuery {
  incoming: ResidentEntry;
  residents: Iterable<TrackedEntry>;
  /** Ids treated as already gone (the same-id resident being replaced). */
  except: ReadonlySet<string>;
  strategy: EvictionStrategy;
  quotas: readonly Quota[];
  byteBudget: number;
  workspaceBytes: number;
}

/**
 * Choose victims without mutating. Same-group residents are offered first,
 * each group in strategy order. Returns `[]` when the admission already fits,
 * and undefined when no subset of unpinned residents makes it fit.
 */
export function selectVictims(query: VictimQuery): TrackedEntry[] | undefined {
  const { incoming, except } = query;
  const applicable = query.quotas.filter((quota) => quotaApplies(quota, incoming));
  const quotaUsed = applicable.map(() => 0);
  let total = 0;
  const evictable: TrackedEntry[] = [];

  for (const entry of query.residents) {
    if (except.has(entry.id)) continue;
    total += entry.bytes;
    for (let i = 0; i < applicable.length; i++) {
      if (quotaApplies(applicable[i]!, entry)) quotaUsed[i] = (quotaUsed[i] ?? 0) + entry.bytes;
    }
    if (!entry.pinned) evictable.push(entry);
  }

  const fits = (): boolean => {
    if (total + query.workspaceBytes + incoming.bytes > query.byteBudget) return false;
    for (let i = 0; i < applicable.length; i++) {
      if ((quotaUsed[i] ?? 0) + incoming.bytes > applicable[i]!.byteCap) return false;
    }
    return true;
  };

  if (fits()) return [];
  const ranked = query.strategy.rank(evictable);
  const sameGroup = ranked.filter((entry) => entry.group === incoming.group);
  const rest = ranked.filter((entry) => entry.group !== incoming.group);
  const chosen: TrackedEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of [...sameGroup, ...rest]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    total -= candidate.bytes;
    for (let i = 0; i < applicable.length; i++) {
      if (quotaApplies(applicable[i]!, candidate)) quotaUsed[i] = (quotaUsed[i] ?? 0) - candidate.bytes;
    }
    chosen.push(candidate);
    if (fits()) return chosen.map((entry) => ({ ...entry }));
  }
  return undefined;
}
