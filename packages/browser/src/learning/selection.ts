/**
 * Phase 7 — strategy selection policies and the underperformance guard.
 *
 * Pure functions over one signature's row of running stats. The learner
 * composes them; none of them records anything or applies anything.
 *   - `candidatePool` — the prevalidated strategies eligible right now.
 *   - `exploit` / `explore` — epsilon-greedy's two arms.
 *   - `banditPick` — opt-in UCB1.
 *   - `revertCheck` — the ONE auto-revert rule, used both when an observation
 *     lands and when a recommendation is about to be made.
 */

import { emptyStat, ucb1, type RunningStat } from './stats.js';
import type { SafeStrategy } from './types.js';

/** One signature's per-strategy stats. */
export type StatRow = ReadonlyMap<string, RunningStat>;

/** A selection and its human-readable why. */
export interface StrategyPick {
  strategy: string;
  reason: string;
}

/** Strategies eligible now: every registered one, minus pressure-sensitive ones under pressure. */
export function candidatePool(
  strategies: ReadonlyMap<string, SafeStrategy>,
  incumbent: string,
  pressured: boolean,
): string[] {
  if (!strategies.has(incumbent)) return [incumbent];
  const ids = [...strategies.keys()];
  const filtered = pressured ? ids.filter((id) => !strategies.get(id)?.pressureSensitive) : ids;
  return filtered.length === 0 ? [incumbent] : filtered;
}

/** Lowest mean cost among strategies with at least `minSamples` samples. */
export function exploit(row: StatRow | undefined, incumbent: string, pool: readonly string[], minSamples: number): StrategyPick {
  let best: string | null = null;
  let bestMean = Number.POSITIVE_INFINITY;
  for (const id of pool) {
    const stat = row?.get(id);
    if (!stat || stat.n < minSamples) continue;
    if (stat.mean < bestMean) {
      bestMean = stat.mean;
      best = id;
    }
  }
  if (!best) {
    return {
      strategy: incumbent,
      reason: `staying with ${incumbent}: no registered strategy has ${minSamples} samples yet`,
    };
  }
  const inc = row?.get(incumbent);
  const incText = inc && inc.n > 0 ? `${inc.mean.toFixed(1)}ms (n=${inc.n})` : 'no samples';
  if (best === incumbent) {
    return {
      strategy: incumbent,
      reason: `${incumbent} has the lowest mean cost (${bestMean.toFixed(1)}ms) among strategies with ≥${minSamples} samples`,
    };
  }
  return {
    strategy: best,
    reason:
      `${best} mean ${bestMean.toFixed(1)}ms beats incumbent ${incumbent} (${incText}) ` +
      `after ≥${minSamples} samples`,
  };
}

/** Uniformly pick an alternative to the incumbent (the incumbent when there is none). */
export function explore(pool: readonly string[], incumbent: string, rng: () => number): string {
  const others = pool.filter((id) => id !== incumbent);
  if (others.length === 0) return incumbent;
  const idx = Math.min(others.length - 1, Math.floor(rng() * others.length));
  return others[idx] ?? incumbent;
}

/** UCB1 over the row; holds on the incumbent until any baseline observation exists. */
export function banditPick(row: StatRow | undefined, incumbent: string, pool: readonly string[]): StrategyPick {
  const totalN = row ? [...row.values()].reduce((sum, s) => sum + s.n, 0) : 0;
  if (totalN <= 0) {
    return {
      strategy: incumbent,
      reason: 'contextual bandit held: no baseline observations yet — staying with incumbent',
    };
  }
  const unsampled = pool.filter((id) => (row?.get(id)?.n ?? 0) === 0);
  const next = unsampled.find((id) => id !== incumbent);
  if (next) {
    return {
      strategy: next,
      reason: `UCB1 exploring unsampled prevalidated strategy ${next} (baseline n=${totalN})`,
    };
  }
  let best = incumbent;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const id of pool) {
    const score = ucb1(row?.get(id) ?? emptyStat(), totalN);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return {
    strategy: best,
    reason: `UCB1 selected ${best} (score ${Number.isFinite(bestScore) ? bestScore.toFixed(4) : 'inf'}) over ${pool.length} prevalidated strategies`,
  };
}

export interface RevertCheckInput {
  row: StatRow | undefined;
  /** The strategy in use (or about to be recommended). */
  candidate: string;
  /** The incumbent it is measured against. */
  baseline: string;
  minSamples: number;
  underperformRatio: number;
}

/**
 * The auto-revert rule: once both have `minSamples` samples, a candidate whose
 * mean cost exceeds the baseline's by more than `underperformRatio` must be
 * reverted. Returns the reason when it must, undefined otherwise.
 */
export function revertCheck(input: RevertCheckInput): string | undefined {
  const { row, candidate, baseline, minSamples, underperformRatio } = input;
  if (candidate === baseline) return undefined;
  const cur = row?.get(candidate);
  const prev = row?.get(baseline);
  if (!cur || !prev || cur.n < minSamples || prev.n < minSamples) return undefined;
  if (!(cur.mean > prev.mean * underperformRatio)) return undefined;
  return (
    `auto-revert: ${candidate} mean ${cur.mean.toFixed(1)}ms exceeds incumbent ${baseline} ` +
    `mean ${prev.mean.toFixed(1)}ms by more than ${Math.round((underperformRatio - 1) * 100)}%`
  );
}
