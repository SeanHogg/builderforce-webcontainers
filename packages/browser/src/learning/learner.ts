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
 *
 * This file composes: selection.ts (pool, exploit/explore, UCB1, the ONE
 * auto-revert rule) · ledger.ts (apply / rollback, bounded history) ·
 * fingerprint.ts (workload signatures) · stats.ts (running means).
 */

import { now as clockNow } from '../shared/clock.js';
import { copyDeltas, createChangeLedger } from './ledger.js';
import { banditPick, candidatePool, exploit, explore, revertCheck, type StrategyPick } from './selection.js';
import { emptyStat, observeStat, type RunningStat } from './stats.js';
import type {
  HistoryEntry,
  Learner,
  LearnerConfig,
  LearningStats,
  ObserveResult,
  Recommendation,
  SafeStrategy,
} from './types.js';

export { fingerprintWorkload, observationFromExecution } from './fingerprint.js';

const DEFAULT_EPSILON = 0.1;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_UNDERPERFORM_RATIO = 1.15;
const DEFAULT_HISTORY_LIMIT = 256;

export function createLearner(config: LearnerConfig = {}): Learner {
  const strategies = new Map<string, SafeStrategy>();
  const table = new Map<string, Map<string, RunningStat>>();
  const incumbentOf = new Map<string, string>();
  const ledger = createChangeLedger(config.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  const rng = config.rng ?? Math.random;
  const now = config.now ?? clockNow;
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
  let recStart = 0;

  function statFor(signature: string, strategy: string): RunningStat {
    let row = table.get(signature);
    if (!row) {
      row = new Map();
      table.set(signature, row);
    }
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

  function finish(rec: Omit<Recommendation, 'overheadMs'>): Recommendation {
    const overheadMs = Math.max(0, now() - recStart);
    lastOverheadMs = overheadMs;
    totalOverheadMs += overheadMs;
    decisions += 1;
    return { ...rec, overheadMs };
  }

  function revertReason(signature: string, candidate: string, baseline: string): string | undefined {
    return revertCheck({ row: table.get(signature), candidate, baseline, minSamples, underperformRatio });
  }

  /** Revert the applied strategy for `signature` when it measurably underperforms its incumbent. */
  function maybeAutoRevert(signature: string): boolean {
    const current = ledger.active(signature);
    const previous = incumbentOf.get(signature);
    if (!current || !previous) return false;
    const reason = revertReason(signature, current, previous);
    if (!reason) return false;
    ledger.record({
      signature,
      from: current,
      to: previous,
      reason,
      deltas: copyDeltas(strategies.get(previous)?.deltas),
      overheadMs: 0,
      at: clock(),
      auto: true,
    });
    lastRevertReason = reason;
    return true;
  }

  function selectStrategy(signature: string, incumbent: string, pool: readonly string[]): StrategyPick {
    const row = table.get(signature);
    if (bandit) return banditPick(row, incumbent, pool);
    if (rng() < epsilon) {
      const explored = explore(pool, incumbent, rng);
      return {
        strategy: explored,
        reason:
          explored === incumbent
            ? `epsilon-greedy explored but no alternative to ${incumbent} is available`
            : `epsilon-greedy exploring prevalidated strategy ${explored} (ε=${epsilon})`,
      };
    }
    return exploit(row, incumbent, pool, minSamples);
  }

  function applyPressure(picked: StrategyPick, incumbent: string, pool: readonly string[]): StrategyPick {
    if (strategies.get(picked.strategy)?.pressureSensitive) {
      return {
        strategy: incumbent,
        reason: `pressure/thermal hot — not recommending pressure-sensitive ${picked.strategy}; staying with ${incumbent}`,
      };
    }
    if (picked.strategy !== incumbent) {
      return { ...picked, reason: `${picked.reason}; pressure/thermal excluded pressure-sensitive strategies` };
    }
    if (pool.every((id) => id === incumbent || !strategies.get(id)?.pressureSensitive) && !picked.reason.includes('pressure')) {
      return { ...picked, reason: `${picked.reason}; pressure/thermal hot, pressure-sensitive strategies excluded` };
    }
    return picked;
  }

  function recommendBody(signature: string, incumbent: string): Recommendation {
    if (!incumbentOf.has(signature)) incumbentOf.set(signature, incumbent);
    const passThrough = (reason: string) =>
      finish({ signature, strategy: incumbent, from: incumbent, reason, deltas: [], autoReverted: false });

    if (disabled) return passThrough('learning disabled — pass-through');
    if (!strategies.has(incumbent)) {
      return passThrough(`refusing to switch: incumbent ${incumbent} is not a registered prevalidated strategy`);
    }

    const reverted = maybeAutoRevert(signature);
    const active = ledger.active(signature);
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

    const pressured = underPressure();
    const pool = candidatePool(strategies, incumbent, pressured);
    let picked = selectStrategy(signature, incumbent, pool);
    if (pressured) picked = applyPressure(picked, incumbent, pool);

    // Guard at decision time too: do not recommend a measured underperformer.
    const baseId = incumbentOf.get(signature) ?? incumbent;
    const revert = revertReason(signature, picked.strategy, baseId);
    if (revert) {
      picked = { strategy: baseId, reason: revert };
      lastRevertReason = revert;
    }

    return finish({
      signature,
      strategy: picked.strategy,
      from: incumbent,
      reason: picked.reason,
      deltas: picked.strategy === incumbent ? [] : copyDeltas(strategies.get(picked.strategy)?.deltas),
      autoReverted: revert !== undefined,
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
      if (!incumbentOf.has(recommendation.signature)) {
        incumbentOf.set(recommendation.signature, recommendation.from);
      }
      if (recommendation.strategy === recommendation.from && !recommendation.autoReverted) {
        ledger.setActive(recommendation.signature, recommendation.strategy);
        return null;
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
      ledger.record(entry);
      return entry;
    },

    rollback() {
      const last = ledger.popLast();
      if (!last) return null;
      return {
        signature: last.signature,
        from: last.to,
        to: last.from,
        reason: `rollback: ${last.reason}`,
        deltas: copyDeltas(strategies.get(last.from)?.deltas),
        overheadMs: 0,
        at: clock(),
        auto: false,
      };
    },

    history() {
      return ledger.history();
    },

    active(signature) {
      return ledger.active(signature);
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
