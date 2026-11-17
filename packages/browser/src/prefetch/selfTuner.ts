/**
 * Phase 4 — the prefetch self-tuner.
 *
 * The measurement is CUMULATIVE, not per-window: the benefit prefetching
 * delivered (the wait it saved callers) against the cost of the speculative
 * loads nobody ever used. A speculative load stays "waste" until a request
 * claims it, so a prefetch that is never used keeps counting against the
 * tuner for as long as it is outstanding.
 *
 * Outstanding loads are tracked individually up to `maxTrackedLoads`; older
 * ones are folded into a scalar so the measurement stays exact for
 * everything except a later claim of a load that old (bounded state).
 */

export interface SelfTunerOptions {
  now: () => number;
  /** Consecutive negative measurements before prefetching is disabled. */
  disableAfter: number;
  /** Measurements required before the tuner may act. */
  minSamples: number;
  /** Re-enable after this many ms. 0 never re-enables. */
  retryAfterMs: number;
  /** Outstanding speculative loads tracked individually. */
  maxTrackedLoads: number;
}

/** What the prefetcher must do after a measurement. */
export type TunerAction = 'none' | 'disable' | 'reenable';

export interface SelfTuner {
  /** A speculative load completed and nobody has claimed it yet. */
  noteSpeculativeLoad(id: string, loadMs: number): void;
  /** A request consumed `id`: its loads were not waste. */
  markClaimed(id: string): void;
  /** Credit the wait a prefetch saved: about `loadMs`, minus what the caller still waited. */
  creditAvoidedWait(loadMs: number, actualWaitMs: number): void;
  /** Evaluate after one measured request. `enabled` is the prefetcher's current switch. */
  evaluate(enabled: boolean): TunerAction;
  readonly selfTunedOff: boolean;
  readonly trips: number;
}

interface OutstandingLoad {
  id: string;
  loadMs: number;
}

export function createSelfTuner(options: SelfTunerOptions): SelfTuner {
  const maxTracked = Math.max(1, options.maxTrackedLoads);
  let outstanding: OutstandingLoad[] = [];
  let retiredWasteMs = 0;
  let avoidedMs = 0;
  let measured = 0;
  let negativeStreak = 0;
  let disabledAt = 0;
  let selfTunedOff = false;
  let trips = 0;

  function wasteMs(): number {
    let total = retiredWasteMs;
    for (const load of outstanding) total += load.loadMs;
    return total;
  }

  return {
    noteSpeculativeLoad(id, loadMs) {
      outstanding.push({ id, loadMs });
      while (outstanding.length > maxTracked) {
        const oldest = outstanding.shift();
        if (oldest) retiredWasteMs += oldest.loadMs;
      }
    },
    markClaimed(id) {
      if (outstanding.some((load) => load.id === id)) {
        outstanding = outstanding.filter((load) => load.id !== id);
      }
    },
    creditAvoidedWait(loadMs, actualWaitMs) {
      avoidedMs += Math.max(0, loadMs - actualWaitMs);
    },
    evaluate(enabled) {
      measured += 1;
      // A self-tuned-off prefetcher may be re-enabled by the retry window.
      if (!enabled && selfTunedOff && options.retryAfterMs > 0 && options.now() - disabledAt >= options.retryAfterMs) {
        selfTunedOff = false;
        negativeStreak = 0;
        avoidedMs = 0;
        outstanding = [];
        retiredWasteMs = 0;
        return 'reenable';
      }
      if (measured < options.minSamples) return 'none';
      // Negative means the speculative work cost more than it saved.
      negativeStreak = wasteMs() > avoidedMs ? negativeStreak + 1 : 0;
      if (negativeStreak >= options.disableAfter && !selfTunedOff) {
        selfTunedOff = true;
        trips += 1;
        disabledAt = options.now();
        return 'disable';
      }
      return 'none';
    },
    get selfTunedOff() {
      return selfTunedOff;
    },
    get trips() {
      return trips;
    },
  };
}
