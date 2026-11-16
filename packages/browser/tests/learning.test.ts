import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome } from '../src/adaptive/types.js';
import { createLearner, fingerprintWorkload, observationFromExecution } from '../src/learning/learner.js';
import { emptyStat, observeStat, ucb1, variance } from '../src/learning/stats.js';
import type { SafeStrategy } from '../src/learning/types.js';

const SIG = 'p1-3|q:q4|prompt:0-128|decode:0-64';

function clock() {
  return 1_700_000_000_000;
}

function advancingNow() {
  let t = 0;
  return () => {
    t += 1.5;
    return t;
  };
}

function registerPair(learner: ReturnType<typeof createLearner>, extra?: Partial<SafeStrategy> & { id?: string }) {
  learner.register({ id: 'cpu-only', validated: true });
  learner.register({
    id: extra?.id ?? 'fast',
    validated: true,
    deltas: extra?.deltas ?? [{ field: 'workers', value: 2 }],
    pressureSensitive: extra?.pressureSensitive,
  });
}

function observeN(
  learner: ReturnType<typeof createLearner>,
  strategy: string,
  costMs: number,
  n: number,
  signature = SIG,
) {
  for (let i = 0; i < n; i++) {
    const result = learner.observe({ signature, strategy, costMs });
    expect(result.accepted).toBe(true);
  }
}

describe('fingerprintWorkload', () => {
  it('buckets a workload deterministically', () => {
    const input = { paramsB: 1.1, quantization: 'q4', promptTokens: 64, decodeTokens: 32 };
    const a = fingerprintWorkload(input);
    const b = fingerprintWorkload(input);
    expect(a).toBe('p1-3|q:q4|prompt:0-128|decode:0-64');
    expect(b).toBe(a);
  });

  it('uses unknown when quantization is empty', () => {
    expect(fingerprintWorkload({ paramsB: 0.5, quantization: '', promptTokens: 0, decodeTokens: 0 })).toBe(
      'p0-1|q:unknown|prompt:0-128|decode:0-64',
    );
  });
});

describe('stats', () => {
  it('tracks a Welford mean and holds variance at 0 until two samples', () => {
    const stat = emptyStat();
    observeStat(stat, 10);
    expect(stat.mean).toBe(10);
    expect(variance(stat)).toBe(0);
    observeStat(stat, 20);
    expect(stat.mean).toBe(15);
    expect(variance(stat)).toBeGreaterThan(0);
  });

  it('returns +Infinity from ucb1 until an arm is sampled', () => {
    expect(ucb1(emptyStat(), 4)).toBe(Number.POSITIVE_INFINITY);
    const sampled = emptyStat();
    observeStat(sampled, 0);
    expect(ucb1(sampled, 4)).toBeLessThan(Number.POSITIVE_INFINITY);
  });
});

describe('createLearner', () => {
  it('refuses an unvalidated strategy and an observation of an unregistered one', () => {
    const learner = createLearner({ now: advancingNow(), clock, rng: () => 0.99 });
    expect(() => learner.register({ id: 'x', validated: false as unknown as true })).toThrow(/unvalidated/);
    expect(() => learner.register({ id: '', validated: true })).toThrow(/unvalidated/);
    learner.register({ id: 'cpu-only', validated: true });
    expect(() => learner.observe({ signature: SIG, strategy: 'ghost', costMs: 1 })).toThrow(/unregistered/);
  });

  it('ignores incorrect and non-finite runs so they cannot teach a strategy', () => {
    const learner = createLearner({ now: advancingNow(), clock, rng: () => 0.99 });
    learner.register({ id: 'cpu-only', validated: true });
    const bad = learner.observe({ signature: SIG, strategy: 'cpu-only', costMs: 10, correct: false });
    const nan = learner.observe({ signature: SIG, strategy: 'cpu-only', costMs: Number.NaN });
    const negative = learner.observe({ signature: SIG, strategy: 'cpu-only', costMs: -1 });
    expect(bad.accepted).toBe(false);
    expect(nan.accepted).toBe(false);
    expect(negative.accepted).toBe(false);
    expect(learner.stats().ignored).toBe(3);
    expect(learner.stats().observations).toBe(0);
  });

  it('is a deterministic pass-through when disabled and never calls rng', () => {
    const learner = createLearner({
      disabled: true,
      now: advancingNow(),
      clock,
      rng: () => {
        throw new Error('rng must not be called while learning is disabled');
      },
    });
    learner.register({ id: 'cpu-only', validated: true });
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.strategy).toBe('cpu-only');
    expect(rec.reason).toMatch(/learning disabled/);
    expect(rec.deltas).toEqual([]);
    expect(rec.autoReverted).toBe(false);
    expect(learner.apply(rec)).toBeNull();
    expect(learner.disabled).toBe(true);
    learner.enable();
    expect(learner.disabled).toBe(false);
    learner.disable();
    expect(learner.disabled).toBe(true);
    expect(learner.recommend(SIG, 'cpu-only').reason).toMatch(/learning disabled/);
  });

  it('exploits the lowest mean only after minSamples, and the reason names that mean', () => {
    const learner = createLearner({ rng: () => 0.99, epsilon: 0.1, minSamples: 3, now: advancingNow(), clock });
    registerPair(learner);
    observeN(learner, 'cpu-only', 100, 2);
    observeN(learner, 'fast', 10, 2);
    const early = learner.recommend(SIG, 'cpu-only');
    expect(early.strategy).toBe('cpu-only');
    expect(early.reason).toMatch(/3 samples/);

    observeN(learner, 'cpu-only', 100, 1);
    observeN(learner, 'fast', 10, 1);
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.strategy).toBe('fast');
    expect(rec.reason.length).toBeGreaterThan(0);
    expect(rec.reason).toMatch(/10\.0ms/);
    expect(rec.deltas).toEqual([{ field: 'workers', value: 2 }]);
    expect(rec.autoReverted).toBe(false);
  });

  it('explores a prevalidated alternative, records it, and rolls it back', () => {
    const learner = createLearner({ rng: () => 0, epsilon: 0.1, now: advancingNow(), clock });
    registerPair(learner);
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.strategy).toBe('fast');
    expect(rec.reason).toMatch(/exploring/);
    const applied = learner.apply(rec);
    expect(applied).not.toBeNull();
    expect(learner.active(SIG)).toBe('fast');
    expect(learner.history()).toHaveLength(1);

    const inverse = learner.rollback();
    expect(inverse).not.toBeNull();
    expect(inverse!.to).toBe('cpu-only');
    expect(inverse!.reason.startsWith('rollback: ')).toBe(true);
    expect(learner.active(SIG)).toBe('cpu-only');
    expect(learner.history()).toHaveLength(0);
    expect(learner.rollback()).toBeNull();
  });

  it('auto-reverts a strategy that is measurably worse than the incumbent', () => {
    const learner = createLearner({
      rng: () => 0,
      epsilon: 0.1,
      minSamples: 3,
      underperformRatio: 1.15,
      now: advancingNow(),
      clock,
    });
    registerPair(learner);
    observeN(learner, 'cpu-only', 10, 3);
    observeN(learner, 'fast', 100, 3);
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.strategy).toBe('cpu-only');
    expect(rec.autoReverted).toBe(true);
    expect(rec.reason.startsWith('auto-revert:')).toBe(true);
  });

  it('excludes pressure-sensitive strategies while pressure or thermal is hot', () => {
    let pressured = true;
    let thermal: 'ok' | 'hot' = 'ok';
    const learner = createLearner({
      rng: () => 0,
      epsilon: 0.1,
      now: advancingNow(),
      clock,
      pressure: () => pressured,
      thermal: () => thermal,
    });
    registerPair(learner, { pressureSensitive: true });
    const underPressure = learner.recommend(SIG, 'cpu-only');
    expect(underPressure.strategy).toBe('cpu-only');
    expect(underPressure.reason).toMatch(/pressure/);

    pressured = false;
    thermal = 'hot';
    expect(learner.recommend(SIG, 'cpu-only').strategy).toBe('cpu-only');

    thermal = 'ok';
    expect(learner.recommend(SIG, 'cpu-only').strategy).toBe('fast');
  });

  it('holds the contextual bandit on the incumbent until baseline data exists', () => {
    const learner = createLearner({
      contextualBandit: true,
      rng: () => 0,
      now: advancingNow(),
      clock,
    });
    registerPair(learner);
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.strategy).toBe('cpu-only');
    expect(rec.reason).toMatch(/contextual bandit held/);
  });

  it('measures its own decision overhead', () => {
    const learner = createLearner({ rng: () => 0.99, now: advancingNow(), clock });
    learner.register({ id: 'cpu-only', validated: true });
    const rec = learner.recommend(SIG, 'cpu-only');
    expect(rec.overheadMs).toBeGreaterThanOrEqual(0);
    const stats = learner.stats();
    expect(stats.decisions).toBe(1);
    expect(Number.isFinite(stats.totalOverheadMs)).toBe(true);
    expect(Number.isFinite(stats.meanOverheadMs)).toBe(true);
    expect(stats.totalOverheadMs).toBeGreaterThanOrEqual(0);
    expect(learner.overheadMs()).toBe(stats.lastOverheadMs);
  });
});

describe('observationFromExecution', () => {
  it('maps a Phase 2 outcome without applying anything', () => {
    const outcome: ExecutionOutcome = {
      decision: {
        route: 'local',
        hardware: {
          cores: 4,
          wasmSimd: true,
          webgpu: false,
          crossOriginIsolated: false,
          sharedArrayBuffer: false,
          ramBytes: 1,
        },
        workload: {
          paramsB: 1.1,
          quantization: 'q4',
          promptTokens: 64,
          decodeTokens: 32,
          residentBytes: 1,
        },
        plan: {
          strategy: 'cpu-only',
          backend: 'mock',
          reasoning: ['cpu-only'],
          estimatedCostMs: 10,
          gpuLayerIds: [],
          cpuLayerIds: ['L0'],
        },
      },
      measuredCostMs: 12,
      overheadMs: 0.4,
      benefitMs: -2,
    };
    const mapped = observationFromExecution(outcome);
    expect(mapped.signature).toBe(fingerprintWorkload(outcome.decision.workload));
    expect(mapped.strategy).toBe('cpu-only');
    expect(mapped.costMs).toBe(12);
    expect(mapped.overheadMs).toBe(0.4);
    expect(mapped.benefitMs).toBe(-2);
    expect(observationFromExecution(outcome, false).correct).toBe(false);
  });
});
