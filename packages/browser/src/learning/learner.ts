/**
 * Phase 7 — Online Performance Learning.
 *
 * Feedback-driven strategy selection. Every output is a plain-data delta plus
 * a reason. Nothing in this module mutates another phase: the caller decides
 * whether to apply a suggestion. Learning is limited to strategies registered
 * as prevalidated, and an observation flagged incorrect is dropped so a bad
 * run cannot teach a strategy that changed correctness.
 *
 * Default policy is epsilon-greedy over per-strategy running means (explainable).
 * UCB1 is opt-in via `contextualBandit` and only consults arms that already
 * have a row in the table.
 */

import type { ExecutionOutcome } from '../adaptive/types.js';
import { emptyStat, observeStat, ucb1, type RunningStat } from './stats.js';
import type {
  ConfigDeltaField,
  HistoryEntry,
  Learner,
  LearnerConfig,
  LearningStats,
  ObserveResult,
  OutcomeObservation,
  Recommendation,
  SafeStrategy,
  WorkloadFingerprintInput,
} from './types.js';

const DEFAULT_EPSILON = 0.1;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_UNDERPERFORM_RATIO = 1.15;

function bucket(value: number, edges: readonly number[]): string {
  let lower = 0;
  for (const edge of edges) {
    if (value < edge) return `${lower}-${edge}`;
    lower = edge;
  }
  const last = edges[edges.length - 1] ?? 0;
  return `${last}+`;
}

/** Stable signature for a workload. Same buckets always produce the same key. */
export function fingerprintWorkload(input: WorkloadFingerprintInput): string {
  const params = bucket(input.paramsB ?? 0, [1, 3, 8]);
  const prompt = bucket(input.promptTokens ?? 0, [128, 512, 2048]);
  const decode = bucket(input.decodeTokens ?? 0, [64, 256, 1024]);
  const quant = input.quantization && input.quantization.length > 0 ? input.quantization : 'unknown';
  return `p${params}|q:${quant}|prompt:${prompt}|decode:${decode}`;
}

/**
 * Map a Phase 2 `ExecutionOutcome` into an observation. Type-only coupling:
 * this does not import the controller, and it does not apply anything.
 */
export function observationFromExecution(outcome: ExecutionOutcome, correct = true): OutcomeObservation {
  const workload = outcome.decision.workload;
  return {
    signature: fingerprintWorkload({
      paramsB: workload.paramsB,
      quantization: workload.quantization,
      promptTokens: workload.promptTokens,
      decodeTokens: workload.decodeTokens,
    }),
    strategy: outcome.decision.plan.strategy,
    costMs: outcome.measuredCostMs,
    overheadMs: outcome.overheadMs,
    benefitMs: outcome.benefitMs,
    correct,
  };
}

function copyDeltas(deltas: ReadonlyArray<ConfigDeltaField> | undefined): ConfigDeltaField[] {
  if (!deltas) return [];
  return deltas.map((d) => ({ field: d.field, value: d.value }));
}

export function createLearner(config: LearnerConfig = {}): Learner {
  const strategies = new Map<string, SafeStrategy>();
  const table = new Map<string, Map<string, RunningStat>>();
  const applied = new Map<string, string>();
  const incumbentOf = new Map<string, string>();
  const history: HistoryEntry[] = [];
  const rng = config.rng ?? Math.random;
  const now = config.now ?? (() => performance.now());
  const clock = config.clock ?? (() => Date.now());
  const epsilon = config.epsilon ?? DEFAULT_EPSILON;
  const minSamples = config.minSamples ?? DEFAULT_MIN_SAMPLES;
  const underperformRatio = config.underperformRatio ?? DEFAULT_UNDERPERFORM_RATIO;
  const bandit = config.contextualBandit ?? false;

  let disabled = config.disabled ?? false;
  let observations = 0;
  let ignored = 0;
  let decisions = 0;
  let lastOverheadMs = 0;
  let totalOverheadMs = 0;
  let lastRevertReason = '';

  function rowFor(signature: string): Map<string, RunningStat> {
    let row = table.get(signature);
    if (!row) {
      row = new Map();
      table.set(signature, row);
    }
    return row;
  }

  function statFor(signature: string, strategy: string): RunningStat {
    const row = rowFor(signature);
    let stat = row.get(strategy);
    if (!stat) {
      stat = emptyStat();
      row.set(strategy, stat);
    }
    return stat;
  }

  function underPressure(): boolean {
    if (config.pressure?.()) return true;
    return config.thermal?.() === 'hot';
  }

  function recordDecision(overheadMs: number): void {
    lastOverheadMs = overheadMs;
    totalOverheadMs += overheadMs;
    decisions += 1;
  }

  function finish(rec: Omit<Recommendation, 'overheadMs'>): Recommendation {
    const overheadMs = Math.max(0, now() - recStart);
    recordDecision(overheadMs);
    return { ...rec, overheadMs };
  }

  let recStart = 0;

  function maybeAutoRevert(signature: string): boolean {
    const current = applied.get(signature);
    const previous = incumbentOf.get(signature);
    if (!current || !previous || current === previous) return false;
    const row = table.get(signature);
    const cur = row?.get(current);
    const prev = row?.get(previous);
    if (!cur || !prev || cur.n < minSamples || prev.n < minSamples) return false;
    if (!(cur.mean > prev.mean * underperformRatio)) return false;
    const reason =
      `auto-revert: ${current} mean ${cur.mean.toFixed(1)}ms exceeds incumbent ${previous} ` +
      `mean ${prev.mean.toFixed(1)}ms by more than ${Math.round((underperformRatio - 1) * 100)}%`;
    history.push({
      signature,
      from: current,
      to: previous,
      reason,
      deltas: copyDeltas(strategies.get(previous)?.deltas),
      overheadMs: 0,
      at: clock(),
      auto: true,
    });
    applied.set(signature, previous);
    lastRevertReason = reason;
    return true;
  }

  function candidates(signature: string, incumbent: string): string[] {
    const ids = [...strategies.keys()];
    if (!strategies.has(incumbent)) return [incumbent];
    const pressured = underPressure();
    const filtered = pressured ? ids.filter((id) => !strategies.get(id)?.pressureSensitive) : ids;
    if (filtered.length === 0) return [incumbent];
    // Keep the signature in the closure so a future per-signature allow-list can narrow this.
    void signature;
    return filtered;
  }

  function exploit(signature: string, incumbent: string, pool: readonly string[]): { strategy: string; reason: string } {
    const row = table.get(signature);
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

  function explore(pool: readonly string[], incumbent: string): string {
    const others = pool.filter((id) => id !== incumbent);
    if (others.length === 0) return incumbent;
    const idx = Math.min(others.length - 1, Math.floor(rng() * others.length));
    return others[idx] ?? incumbent;
  }

  function banditPick(signature: string, incumbent: string, pool: readonly string[]): { strategy: string; reason: string } {
    const row = table.get(signature);
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
      const stat = row?.get(id) ?? emptyStat();
      const score = ucb1(stat, totalN);
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

  function recommendBody(signature: string, incumbent: string): Recommendation {
    if (!incumbentOf.has(signature)) incumbentOf.set(signature, incumbent);

    if (disabled) {
      return finish({
        signature,
        strategy: incumbent,
        from: incumbent,
        reason: 'learning disabled — pass-through',
        deltas: [],
        autoReverted: false,
      });
    }

    if (!strategies.has(incumbent)) {
      return finish({
        signature,
        strategy: incumbent,
        from: incumbent,
        reason: `refusing to switch: incumbent ${incumbent} is not a registered prevalidated strategy`,
        deltas: [],
        autoReverted: false,
      });
    }

    const reverted = maybeAutoRevert(signature);
    const active = applied.get(signature);
    if (reverted && active) {
      return finish({
        signature,
        strategy: active,
        from: incumbent,
        reason: lastRevertReason,
        deltas: copyDeltas(strategies.get(active)?.deltas),
        autoReverted: true,
      });
    }

    const pool = candidates(signature, incumbent);
    const pressured = underPressure();
    let picked: { strategy: string; reason: string };

    if (bandit) {
      picked = banditPick(signature, incumbent, pool);
    } else if (rng() < epsilon) {
      const explored = explore(pool, incumbent);
      picked = {
        strategy: explored,
        reason:
          explored === incumbent
            ? `epsilon-greedy explored but no alternative to ${incumbent} is available`
            : `epsilon-greedy exploring prevalidated strategy ${explored} (ε=${epsilon})`,
      };
    } else {
      picked = exploit(signature, incumbent, pool);
    }

    if (pressured && strategies.get(picked.strategy)?.pressureSensitive) {
      picked = {
        strategy: incumbent,
        reason: `pressure/thermal hot — not recommending pressure-sensitive ${picked.strategy}; staying with ${incumbent}`,
      };
    } else if (pressured && picked.strategy !== incumbent) {
      picked = {
        ...picked,
        reason: `${picked.reason}; pressure/thermal excluded pressure-sensitive strategies`,
      };
    } else if (pressured && pool.every((id) => id === incumbent || !strategies.get(id)?.pressureSensitive)) {
      if (!picked.reason.includes('pressure')) {
        picked = { ...picked, reason: `${picked.reason}; pressure/thermal hot, pressure-sensitive strategies excluded` };
      }
    }

    // Guard at decision time too: do not recommend a measured underperformer.
    const row = table.get(signature);
    const chosenStat = row?.get(picked.strategy);
    const baseId = incumbentOf.get(signature) ?? incumbent;
    const baseStat = row?.get(baseId);
    let autoReverted = false;
    if (
      picked.strategy !== baseId &&
      chosenStat &&
      baseStat &&
      chosenStat.n >= minSamples &&
      baseStat.n >= minSamples &&
      chosenStat.mean > baseStat.mean * underperformRatio
    ) {
      const reason =
        `auto-revert: ${picked.strategy} mean ${chosenStat.mean.toFixed(1)}ms exceeds incumbent ${baseId} ` +
        `mean ${baseStat.mean.toFixed(1)}ms by more than ${Math.round((underperformRatio - 1) * 100)}%`;
      picked = { strategy: baseId, reason };
      autoReverted = true;
      lastRevertReason = reason;
    }

    return finish({
      signature,
      strategy: picked.strategy,
      from: incumbent,
      reason: picked.reason,
      deltas: picked.strategy === incumbent ? [] : copyDeltas(strategies.get(picked.strategy)?.deltas),
      autoReverted,
    });
  }

  const learner: Learner = {
    register(strategy) {
      if (strategy.validated !== true || !strategy.id) {
        throw new Error(`refusing unvalidated strategy: ${strategy.id || '(missing id)'}`);
      }
      strategies.set(strategy.id, {
        id: strategy.id,
        validated: true,
        deltas: copyDeltas(strategy.deltas),
        pressureSensitive: strategy.pressureSensitive ?? false,
      });
    },

    observe(observation): ObserveResult {
      if (!strategies.has(observation.strategy)) {
        throw new Error(`refusing observation for unregistered strategy: ${observation.strategy}`);
      }
      if (observation.correct === false) {
        ignored += 1;
        return { accepted: false, reason: 'ignored: correctness flag false — learning will not train on a run that changed correctness' };
      }
      if (!Number.isFinite(observation.costMs) || observation.costMs < 0) {
        ignored += 1;
        return { accepted: false, reason: 'ignored: costMs must be a finite non-negative number' };
      }
      observeStat(statFor(observation.signature, observation.strategy), observation.costMs);
      observations += 1;
      maybeAutoRevert(observation.signature);
      return { accepted: true, reason: 'recorded' };
    },

    recommend(signature, incumbent) {
      recStart = now();
      return recommendBody(signature, incumbent);
    },

    apply(recommendation) {
      if (disabled) return null;
      if (recommendation.strategy === recommendation.from && !recommendation.autoReverted) {
        if (!incumbentOf.has(recommendation.signature)) {
          incumbentOf.set(recommendation.signature, recommendation.from);
        }
        applied.set(recommendation.signature, recommendation.strategy);
        return null;
      }
      if (!incumbentOf.has(recommendation.signature)) {
        incumbentOf.set(recommendation.signature, recommendation.from);
      }
      const entry: HistoryEntry = {
        signature: recommendation.signature,
        from: recommendation.from,
        to: recommendation.strategy,
        reason: recommendation.reason,
        deltas: copyDeltas(recommendation.deltas),
        overheadMs: recommendation.overheadMs,
        at: clock(),
        auto: recommendation.autoReverted,
      };
      history.push(entry);
      applied.set(recommendation.signature, recommendation.strategy);
      return entry;
    },

    rollback() {
      const last = history[history.length - 1];
      if (!last) return null;
      history.pop();
      applied.set(last.signature, last.from);
      const inverse: HistoryEntry = {
        signature: last.signature,
        from: last.to,
        to: last.from,
        reason: `rollback: ${last.reason}`,
        deltas: copyDeltas(strategies.get(last.from)?.deltas),
        overheadMs: 0,
        at: clock(),
        auto: false,
      };
      return inverse;
    },

    history() {
      return history;
    },

    active(signature) {
      return applied.get(signature);
    },

    overheadMs() {
      return lastOverheadMs;
    },

    stats(): LearningStats {
      return {
        decisions,
        observations,
        ignored,
        lastOverheadMs,
        totalOverheadMs,
        disabled,
        meanOverheadMs: decisions === 0 ? 0 : totalOverheadMs / decisions,
      };
    },

    disable() {
      disabled = true;
    },

    enable() {
      disabled = false;
    },

    get disabled() {
      return disabled;
    },
  };

  return learner;
}
