/**
 * Phase 4 — the ONE admission gate for speculative loads.
 *
 * Both the prediction path (`predict` / auto-predict after a request) and the
 * explicit `prefetch()` call ask this gate before starting a speculative load.
 * The gate counts the attempt, applies the checks in a fixed order, records
 * the explainable event for every refusal, and relieves pressure when the
 * pressure signal is up:
 *
 *   disabled → pressure → unknown target → already resident → already loading → concurrency cap
 *
 * Only targets in the target index are admitted. Demand loads (`request`) never
 * pass through this gate, and an explicit `prefetch(target)` learns its target
 * first, so the refusal only bites predictions of unknown or forgotten ids.
 */

import type { PrefetchLedger } from './stats.js';
import type { PrefetchReason, PrefetchSkipReason, PrefetchTarget } from './types.js';

/** Outcome of asking to start a speculative load. */
export type AdmissionVerdict =
  | { admit: true }
  | { admit: false; result: 'duplicate' | 'throttled'; skipReason: PrefetchSkipReason };

export interface AdmissionGateOptions {
  ledger: PrefetchLedger;
  maxConcurrent: number;
  isEnabled(): boolean;
  isPressure(): boolean;
  /** Called when pressure refuses an admission: drop speculative work and unclaimed data. */
  relievePressure(): void;
  /** Whether the id is in the target index (declared, or learned and not yet forgotten). */
  isKnown(id: string): boolean;
  isResident(id: string): boolean;
  isLoading(id: string): boolean;
  speculativeCount(): number;
}

export type DecideAdmission = (target: PrefetchTarget, strategy: PrefetchReason) => AdmissionVerdict;

export function createAdmissionGate(options: AdmissionGateOptions): DecideAdmission {
  const { ledger } = options;
  const counters = ledger.counters;

  function refuse(
    target: PrefetchTarget,
    strategy: PrefetchReason,
    outcome: 'skipped' | 'throttled' | 'duplicate',
    skipReason: PrefetchSkipReason,
  ): AdmissionVerdict {
    if (outcome === 'throttled') counters.throttled += 1;
    else counters.skipped += 1;
    ledger.record({ id: target.id, strategy, outcome, durationMs: 0, skipReason });
    return { admit: false, result: outcome === 'duplicate' ? 'duplicate' : 'throttled', skipReason };
  }

  return function decideAdmission(target, strategy) {
    counters.attempts += 1;
    if (!options.isEnabled()) return refuse(target, strategy, 'skipped', 'disabled');
    if (options.isPressure()) {
      options.relievePressure();
      return refuse(target, strategy, 'throttled', 'pressure');
    }
    // An unknown id has no real footprint (a predictor's 0-byte placeholder): loading it
    // speculatively would hold data the resident byte budget cannot see.
    if (!options.isKnown(target.id)) return refuse(target, strategy, 'skipped', 'unknown-target');
    if (options.isResident(target.id)) return refuse(target, strategy, 'duplicate', 'already-loaded');
    if (options.isLoading(target.id)) return refuse(target, strategy, 'duplicate', 'already-loading');
    if (options.speculativeCount() >= options.maxConcurrent) {
      return refuse(target, strategy, 'skipped', 'concurrency-limit');
    }
    return { admit: true };
  };
}
