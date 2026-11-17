/**
 * Phase 7 — Online Performance Learning: shared types.
 *
 * Learning emits plain-data suggestions. It never applies them to another
 * module, and it never changes model correctness or memory semantics.
 */

/** A strategy the learner is allowed to recommend. Unregistered ids are refused. */
export interface SafeStrategy {
  id: string;
  /**
   * Must be `true`. The learner refuses a strategy that has not been marked
   * prevalidated — it will not invent or trial an unknown execution path.
   */
  validated: true;
  /** Plain-data config this strategy implies. Copied into recommendations; never applied here. */
  deltas?: ReadonlyArray<ConfigDeltaField>;
  /** Heavier on memory or thermals. Skipped while pressure/thermal is hot. */
  pressureSensitive?: boolean;
}

export interface ConfigDeltaField {
  field: string;
  value: string | number | boolean;
}

/** Bucketed workload identity. Same buckets ⇒ same signature. */
export interface WorkloadFingerprintInput {
  paramsB?: number;
  quantization?: string;
  promptTokens?: number;
  decodeTokens?: number;
}

/** One measured run. `correct: false` is ignored so a bad run cannot teach a strategy. */
export interface OutcomeObservation {
  signature: string;
  strategy: string;
  /** Wall-clock cost. Lower is better. */
  costMs: number;
  overheadMs?: number;
  benefitMs?: number;
  /**
   * When `false`, the observation is dropped. Omitted means the caller asserts
   * the run preserved correctness (the only kind of run learning may use).
   */
  correct?: boolean;
}

export interface Recommendation {
  signature: string;
  /** Strategy to use. Equals the incumbent when learning declines to switch. */
  strategy: string;
  /** Previous strategy, when this recommendation would change it. */
  from: string;
  /** Human-readable why. Always present. */
  reason: string;
  /** Suggestions only. Applying them is the caller's job. */
  deltas: ConfigDeltaField[];
  /** Time spent producing this recommendation. */
  overheadMs: number;
  /** True when the guard reverted an underperforming strategy. */
  autoReverted: boolean;
}

export interface HistoryEntry {
  signature: string;
  from: string;
  to: string;
  reason: string;
  deltas: ConfigDeltaField[];
  overheadMs: number;
  at: number;
  auto: boolean;
}

export interface LearningStats {
  decisions: number;
  observations: number;
  ignored: number;
  lastOverheadMs: number;
  totalOverheadMs: number;
  disabled: boolean;
  /** Mean recorded overhead per decision. */
  meanOverheadMs: number;
}

export interface LearnerConfig {
  /** When true, recommend() is a deterministic pass-through and apply() is a no-op. */
  disabled?: boolean;
  /** Exploration rate for epsilon-greedy. Ignored when disabled. Default 0.1. */
  epsilon?: number;
  /** Samples required before a strategy can win on exploit. Default 3. */
  minSamples?: number;
  /**
   * Auto-revert when the applied strategy's mean cost exceeds the incumbent's
   * by this factor. Default 1.15 (15% worse).
   */
  underperformRatio?: number;
  /**
   * Optional. When true (and only after the table has observations), selection
   * uses UCB1 on inverse cost instead of epsilon-greedy. Default false.
   */
  contextualBandit?: boolean;
  /** Injectable clock so tests can pin overhead accounting. Default `performance.now`. */
  now?: () => number;
  /** Injectable RNG in `[0, 1)`. Default `Math.random`. Never called when disabled. */
  rng?: () => number;
  /** Resource pressure. When true, pressure-sensitive strategies are not chosen. */
  pressure?: () => boolean;
  /** Thermal band. `'hot'` is treated as pressure. */
  thermal?: () => 'ok' | 'warm' | 'hot';
  clock?: () => number;
  /**
   * Applied changes kept in `history()` (and reachable by `rollback()`),
   * oldest dropped first. Default 256.
   */
  historyLimit?: number;
}

export interface ObserveResult {
  accepted: boolean;
  reason: string;
}

export interface Learner {
  register(strategy: SafeStrategy): void;
  observe(observation: OutcomeObservation): ObserveResult;
  recommend(signature: string, incumbent: string): Recommendation;
  /** Record a recommendation as applied. Does not mutate any other module. */
  apply(recommendation: Recommendation): HistoryEntry | null;
  /** Undo the last applied change. Returns the inverse entry, or null if none. */
  rollback(): HistoryEntry | null;
  history(): readonly HistoryEntry[];
  /** Strategy currently recorded as applied for this signature, if any. */
  active(signature: string): string | undefined;
  overheadMs(): number;
  stats(): LearningStats;
  disable(): void;
  enable(): void;
  readonly disabled: boolean;
}
