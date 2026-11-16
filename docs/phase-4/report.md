# Phase 4 — Predictive Prefetching & Streaming

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 4 implemented — typecheck, test and build gates green (154/154 tests pass)

> **Scope honored:** Everything here is browser-compatible only — pure TypeScript, no native code, no new runtime dependency. The prefetcher is deliberately decoupled from every other phase: `src/inference/` only knows *how* to run and never asks to prefetch, `src/adaptive/` decides *where/how* to run and never triggers a prefetch, and `src/memory/` owns residency — the prefetcher only **reads** a pressure signal from it. No existing public API was changed — only additive exports in `packages/browser/src/index.ts`.

---

## 1. What was built

A self-contained predictive prefetching layer under `packages/browser/src/prefetch/`:

| Path | Role |
|------|------|
| `src/prefetch/types.ts` | `PrefetchTarget`, `PrefetchContext`, `PrefetchConfig`, `PrefetchStats`, `PrefetchEvent`, `PrefetchPrediction`, `PrefetchOutcome`/`PrefetchSkipReason`, `PrefetchGraph`/`PrefetchEdge`, `Prefetcher`, `ShouldThrottle`. |
| `src/prefetch/predictor.ts` | The three prediction strategies — `predictFromGraph` (static dependency graph), `predictFromHistory` (order-1 transition table over the access history), `predictFromContext` (workload profile: explicit expectations, stage progression, label overlap) — plus `mergePredictions`, which keeps the best confidence per target id. |
| `src/prefetch/prefetcher.ts` | `createPrefetcher` — the prefetcher itself: resident set, in-flight registry, hit/miss + wait accounting, pressure gating, concurrency cap, cancellation, resident byte budget, and the self-tuner. |
| `src/prefetch/streaming.ts` | `createDoubleBuffer` + `pumpDoubleBuffer` (two-slot buffer: the chunk being consumed is never the chunk being produced) and `createPrefillStream` (prefill-token streaming that degrades gracefully when the backend cannot stream prefill). |
| `tests/prefetch.test.ts` | 22 tests: strategy correctness, hit-rate/wait accounting, prefetch-on-vs-off throughput, in-flight join (no double load), pressure gating, concurrency cap, unclaimed-data release, resident budget, self-tuner trip/no-trip, cancellation, double buffering, prefill streaming with and without backend support, decoupling. |

### Key design decisions

- **Prefetching is an optimization, never a decision.** A prefetch never blocks the active request: the load runs in the background and the caller only ever waits for data it asked for. A missed prediction costs exactly what the caller would have cost anyway.
- **Three independent strategies, one merge.** `static-graph` (declared dependency edges, ranked by the weakest edge on the path), `history` (empirical next-item transition probability, damped by how many transitions were observed), `context` (the caller's workload profile). `mergePredictions` keeps the highest-confidence prediction per target id, so strategies never fight over the same target.
- **Pressure is read, never owned.** The prefetcher accepts an injected `shouldThrottle()` — in production this is wired to the Phase 3 residency manager's `pressure().pressured`. Under pressure: no new prefetch starts, in-flight speculative loads are aborted, unclaimed prefetched data is released, and the resident set is trimmed to its byte budget. Prefetching cannot grow memory without bound.
- **A request joins an in-flight prefetch** rather than starting a second load of the same data — a speculative load that a request attaches to is exactly one load, and the request is served from the prefetched copy.
- **The self-tuner measures, it does not guess.** It compares the wait a prefetch actually *saved* against the speculative load time nobody ever used. When the benefit is repeatedly negative it disables prefetching, releases unclaimed data and records why. The measurement is cumulative — an unclaimed load keeps counting as waste until a request claims it, so a genuinely useless prediction cannot be washed away by a later lucky hit.
- **Prefill streaming is a probed fact, not a gate.** `createPrefillStream` asks the backend whether it can stream prefill; if it cannot (or the probe throws), the adapter yields no prefill tokens and streams decode only. The decode tokens are identical either way, so nothing downstream special-cases it.

---

## 2. Acceptance criteria — where each one is proven

| Criterion | Surface | Test |
|-----------|---------|------|
| Prefetch hit rate measured | `stats().hitRate` / `stats().hits` / `stats().misses` / `stats().prefetchHits`; `hitRate()` | `exposes hitRate() and waitMs() accounting` |
| Time waiting for data measured | `stats().totalWaitMs` / `stats().waitMs`; per-request `PrefetchRequestResult.waitMs` | `exposes hitRate() and waitMs() accounting` |
| Throughput compared with prefetch on vs off | on-vs-off elapsed time **and** per-request wait time, prefetch on strictly faster | `measures a measurable throughput difference between prefetch on and off` |
| Prefetching does not cause memory thrashing | pressure gate, `maxConcurrent` cap, unclaimed-data release, `residentBudgetBytes` | `skips prefetches under pressure and bounds concurrent prefetches`, `drops unclaimed prefetched data under pressure`, `keeps the resident prefetch set inside its byte budget` |
| Strategies that consistently hurt are automatically disabled | `stats().selfTunedOff` / `selfTuneTrips`; `isEnabled()` | `disables prefetching when the measured benefit is repeatedly negative` (+ the positive-benefit counterpart that must *not* trip) |

---

## 3. What Phase 5+ must know

- **The prefetcher loads; it never runs.** It takes an injected `loader(target, signal)` and knows nothing about inference backends. To serve weights, pass a loader that resolves from the Phase 1 model cache.
- **Pressure comes from Phase 3.** Wire `shouldThrottle` to `residencyManager.pressure().pressured` — the prefetcher reads the signal and never mutates residency state.
- **Prediction inputs are additive.** `predict(context)` accepts an explicit workload profile (`expects`, `stage`, `labels`, `paramsB`, `quantization`). Phase 7's online learning can feed learned priors into `graph` and `profile.labels` without changing the prefetcher.
- **Everything is measurable already.** `stats()` exposes hit rate, wait time, average load time, peak concurrency, resident bytes and self-tuner trips — Phase 8 benchmarking can consume these directly rather than re-instrumenting.
- **No new dependency was added.** Keep it that way.

---

## 4. Verification

```
pnpm --filter @seanhogg/builderforce-webcontainers typecheck   # exit 0
pnpm --filter @seanhogg/builderforce-webcontainers test        # 22 files, 154 tests, all pass
pnpm --filter @seanhogg/builderforce-webcontainers build       # exit 0
```

All gates run from the `builderforce-webcontainers` workspace root (the lockfile owner). The package defines no `lint` script, so `typecheck` + `test` + `build` are the complete gate set.
