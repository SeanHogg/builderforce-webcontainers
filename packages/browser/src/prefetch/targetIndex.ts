/**
 * Phase 4 — the bounded index of known prefetch targets.
 *
 * Targets declared in `config.targets` are permanent. Targets the prefetcher
 * learns from `request` / `prefetch` calls are remembered up to a cap, oldest
 * forgotten first, so a workload with unbounded distinct ids cannot grow the
 * index without limit. The Map itself is what the predictors read.
 */

import type { TargetIndex } from './predictor.js';
import type { PrefetchTarget } from './types.js';

export interface BoundedTargetIndex {
  /** The live index the predictors read. */
  readonly index: TargetIndex;
  /** Remember a target first seen at runtime. No-op when already known. */
  remember(target: PrefetchTarget): void;
}

export function createTargetIndex(declared: readonly PrefetchTarget[], maxLearned: number): BoundedTargetIndex {
  const index: TargetIndex = new Map();
  for (const target of declared) index.set(target.id, target);
  const learned = new Set<string>();
  const cap = Math.max(1, maxLearned);

  return {
    index,
    remember(target) {
      if (index.has(target.id)) return;
      index.set(target.id, target);
      learned.add(target.id);
      while (learned.size > cap) {
        const oldest = learned.values().next().value as string | undefined;
        if (oldest === undefined) break;
        learned.delete(oldest);
        index.delete(oldest);
      }
    },
  };
}
