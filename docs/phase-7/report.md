# Phase 7 — Online Performance Learning

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 7 implemented — typecheck and browser test gate green (168/168 tests pass)

> **Scope honored:** Everything here is browser-compatible only — pure TypeScript, no native code, no new runtime dependency. The learner is deliberately decoupled from every other phase: it emits plain-data suggestions and a reason, and it never applies them to inference, memory, prefetch, or the adaptive controller. CPU-only operation is unchanged. Learning can be disabled for deterministic tests. No existing public API was changed — only additive exports in `packages/browser/src/index.ts`.

---

## 1. What was built

A self-contained online learner under `packages/browser/src/learning/`:

| Path | Role |
|------|------|
| `src/learning/types.ts` | `SafeStrategy` (must be `validated: true`), `OutcomeObservation`, `Recommendation`, `HistoryEntry`, `LearnerConfig`, `LearningStats`. |
| `src/learning/stats.ts` | Welford running mean/variance and UCB1 on inverse cost. Unsampled arms score `+Infinity`. |
| `src/learning/learner.ts` | `createLearner`, `fingerprintWorkload`, `observationFromExecution`. Epsilon-greedy by default; UCB1 only when `contextualBandit` is set and only after the table has baseline rows. |
| `src/learning/index.ts` | Barrel. Re-exported additively from `packages/browser/src/index.ts`. |
| `tests/learning.test.ts` | 14 tests: fingerprint stability, prevalidated-only registration, ignored incorrect runs, disable pass-through, exploit after `minSamples`, explore + rollback, auto-revert, pressure/thermal exclusion, bandit held until data, measured overhead, Phase 2 outcome mapping. |

### Key design decisions

- **Suggestions only.** `recommend()` returns a strategy id, copied config deltas, and a reason. `apply()` records that the caller accepted it. Nothing in this module writes worker counts, cache policy, prefetch config, or model state.
- **Only prevalidated strategies.** `register` throws unless `validated === true` and the id is non-empty. An observation for an unregistered id throws. An observation with `correct: false`, or a non-finite / negative `costMs`, is counted in `stats().ignored` and does not update the table, so a run that changed correctness cannot teach a strategy.
- **Deterministic when disabled.** `disabled: true` (or `disable()`) makes `recommend()` a pass-through of the incumbent and `apply()` a no-op. The injected RNG is not called.
- **No silent degradation.** If a chosen strategy's mean cost exceeds the first-seen incumbent by `underperformRatio` (default 15%) after `minSamples` (default 3) on both arms, the recommendation returns to the incumbent with `autoReverted: true` and a reason starting `auto-revert:`. `rollback()` pops the last applied change and returns the inverse entry.
- **Pressure and thermal are read, not owned.** When `pressure()` is true or `thermal()` is `'hot'`, pressure-sensitive strategies are excluded.
- **Bandits wait for a baseline.** With `contextualBandit: true` and zero observations, the learner stays on the incumbent and says so. UCB1 is not used to invent a first strategy.
- **Overhead is measured.** Each `recommend()` records elapsed time from the injected clock into `overheadMs` and `stats()`.

---

## 2. Acceptance criteria — where each one is proven

| Criterion | Surface | Test |
|-----------|---------|------|
| Decisions measurable + explainable | `Recommendation.reason` is always a non-empty string naming the mean or the rule that fired | `exploits the lowest mean only after minSamples, and the reason names that mean` |
| Strategy changes can be rolled back | `apply` / `rollback` / `active` / `history` | `explores a prevalidated alternative, records it, and rolls it back` |
| Learning overhead measured | `Recommendation.overheadMs`, `stats().totalOverheadMs`, `meanOverheadMs` | `measures its own decision overhead` |
| Performance does not degrade unpredictably | auto-revert when mean exceeds incumbent by `underperformRatio` | `auto-reverts a strategy that is measurably worse than the incumbent` |
| Optimization can be disabled for deterministic testing | `LearnerConfig.disabled`, `disable()` / `enable()` | `is a deterministic pass-through when disabled and never calls rng` |
| Constrained to prevalidated strategies | `register` throws; unregistered `observe` throws | `refuses an unvalidated strategy and an observation of an unregistered one` |
| Does not train on incorrect runs | `correct: false` increments `ignored` | `ignores incorrect and non-finite runs so they cannot teach a strategy` |
| Thermal + resource-pressure awareness | `pressure` / `thermal` hooks exclude `pressureSensitive` strategies | `excludes pressure-sensitive strategies while pressure or thermal is hot` |
| Contextual bandit only after baseline data | `contextualBandit: true` with an empty table stays on the incumbent | `holds the contextual bandit on the incumbent until baseline data exists` |
| Workload characteristics tracked | `fingerprintWorkload` buckets params / quant / prompt / decode | `buckets a workload deterministically` |

---

## 3. What Phase 8 must know

- **The learner does not execute and does not configure.** To close the loop, a host calls `observationFromExecution` on a Phase 2 `ExecutionOutcome`, then `recommend`, then applies the returned deltas itself. This module will not do that.
- **Disable it in any deterministic benchmark.** `disabled: true` is the supported way to keep scheduling identical across runs.
- **Do not treat a recommendation as a measured speedup.** The table ranks recorded `costMs`. A wall-clock claim still needs the Phase 0 harness and the noise rule in `scripts/benchmark/README.md`.
- **No new dependency was added.** Keep it that way.

---

## 4. Verification

Commands run from `builderforce-webcontainers/`. `pnpm --filter @seanhogg/builderforce-webcontainers` prints `No projects matched the filters` and then runs the package script from `packages/browser/package.json` (same note as the Phase 5 report). Both exits were 0.

### Typecheck — exit 0

```
> @seanhogg/builderforce-webcontainers@2026.10.13 typecheck C:\code\agentic\builderforce-webcontainers\packages\browser
> node ./node_modules/typescript-7/bin/tsc --noEmit
```

### Tests — exit 0

```
> @seanhogg/builderforce-webcontainers@2026.10.13 test C:\code\agentic\builderforce-webcontainers\packages\browser
> vitest run

 Test Files  23 passed (23)
      Tests  168 passed (168)
   Duration  13.50s
```

`tests/learning.test.ts` — 14 passed (33ms in the isolated run, 37ms inside the package suite).
