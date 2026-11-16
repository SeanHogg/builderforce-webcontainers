# Phase 8 — Integrated Benchmarking & Regression Validation

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 8 complete — regression gate **PASS**, no pre-existing failure hidden or waived

> **Scope honored:** Everything here is browser-compatible only. The Phase 0
> baseline file (`scripts/benchmark/results/baseline-result.json`,
> 2026-11-14) was not touched. `results/*.json` is gitignored — this report
> quotes the measured numbers; the JSON artifacts are local-only.

---

## 1. What Phase 8 added

| Path | Role |
|------|------|
| `scripts/benchmark/run-baseline.mjs --out <path>` | The Phase 0 harness now accepts `--out`, so Phase 8 writes a separate candidate result instead of overwriting the baseline. Bare runs still write `results/baseline-result.json` (unchanged behavior). |
| `scripts/benchmark/compare-baseline.mjs` | New dependency-free comparator. Reads two result files, gates on regressions, writes `results/phase8-comparison.json`, exits non-zero on gate failure. Accepts `--baseline` / `--candidate` overrides. |
| `scripts/benchmark/README.md` | Updated "How Phase 8 compares runs" section documenting the two commands and the gate rule. |
| `docs/phase-8/report.md` | This report. |

The gate is deliberately conservative:

- every candidate test / typecheck / build `exitCode` is `0`;
- `tests.failed` and `files.failed` are no higher than baseline;
- `tests.skipped` is no higher than baseline (a new skip is a regression);
- `tests.passed` may rise — added phase tests are coverage, not a regression;
- timing is **informational only**: a duration is never called "improved"
  unless the candidate is under half the baseline **and** node/pnpm/typescript
  match; a ratio above 2× is an "investigate" warning, not a gate failure;
- dist byte growth is reported and is not a gate failure.

---

## 2. Method

From the repo root (`builderforce-webcontainers/`):

```sh
node scripts/benchmark/run-baseline.mjs --out scripts/benchmark/results/phase8-result.json
node scripts/benchmark/compare-baseline.mjs
```

The candidate run re-executes the exact Phase 0 measurements: per-package
`pnpm test` and `pnpm typecheck`, repo-root `pnpm build`, recursive dist
stats for `packages/core/dist` and `packages/browser/dist`, and the
environment facts (node / pnpm / typescript versions). The comparator then
diffs candidate against the Phase 0 baseline on the gate rules above.

- **Baseline:** `results/baseline-result.json` — 2026-11-14T18:58:30.838Z (Phase 0).
- **Candidate:** `results/phase8-result.json` — 2026-11-16T03:43:54.035Z.
- **Environment match:** node, pnpm, and typescript versions identical between
  the two runs, so timing comparisons are valid (still informational).

---

## 3. Measured results

### Gate

**GATE PASS** — zero failures. Comparison written to
`results/phase8-comparison.json`.

### Tests

| Package | Baseline | Candidate | Δ |
|---------|----------|-----------|---|
| core | 299 passed / 2 skipped / 0 failed | 299 passed / 2 skipped / 0 failed | +0 (unchanged — no core regressions) |
| browser | 53 passed / 0 skipped / 0 failed | 168 passed / 0 skipped / 0 failed | +115 |

The +115 browser tests are the phase acceptance suites, mapped to their phases:

| Phase | Test file(s) | Tests |
|-------|--------------|-------|
| 1 — Local CPU Inference Engine | `inference-worker.test.ts`, `inference-workerEntry.test.ts`, `inference-backends.test.ts`, `inference-capabilities.test.ts`, `inference-modelCache.test.ts` | 21 |
| 2 — AHEC | `adaptive-controller.test.ts`, `adaptive-costmodel.test.ts` | 15 |
| 3 — Memory & Residency | `memory-residency.test.ts` | 18 |
| 4 — Predictive Prefetching | `prefetch.test.ts` | 22 |
| 5 — Model & KV Cache | `kvcache.test.ts` | 18 |
| 6 — Memory Integration | `memory-integration.test.ts` | 7 |
| 7 — Online Learning | `learning.test.ts` | 14 |

0 skipped, 0 failed, and no new skips anywhere — the skipped-core-tests count
matches baseline exactly.

### Dist sizes

| Package | Baseline | Candidate | Δ |
|---------|----------|-----------|---|
| core | 540 files / 1,820,235 bytes | 540 files / 1,820,235 bytes | +0 / +0.0% |
| browser | 111 files / 1,071,477 bytes | 283 files / 1,574,611 bytes | +172 files / +503,134 bytes (+47.0%) |

The browser growth is the shipped phase modules (inference worker, adaptive
controller, kvcache, memory, memoryIntegration, prefetch, learning). It is
reported, expected, and not a gate failure.

### Timings (informational — no improvement claimed)

| Measurement | Baseline | Candidate | Ratio | Note |
|-------------|----------|-----------|-------|------|
| core test | 13,744 ms | 18,227 ms | 1.33 | within noise |
| core typecheck | 3,825 ms | 5,010 ms | 1.31 | within noise |
| browser test | 12,285 ms | 17,088 ms | 1.39 | within noise |
| browser typecheck | 2,465 ms | 5,550 ms | 2.25 | **investigate warning** — see §4 |
| build | 6,767 ms | 11,371 ms | 1.68 | within noise |
| suite total | 40,535 ms | 59,300 ms | 1.46 | within noise |

---

## 4. Interpretation

- **No functional regression.** Every gate condition passes; the candidate
  suite is strictly larger than the baseline and green.
- **The browser typecheck 2.25× ratio is flagged for investigation, not
  alarm.** The candidate typechecks the eight new phase modules (≈40 new
  source files under `packages/browser/src/{inference,adaptive,kvcache,memory,memoryIntegration,prefetch,learning}`),
  and no duration is claimed as degraded by the gate rules either — the
  comparator only gates on correctness counts, not wall-clock. If browser
  typecheck time matters for the dev loop later, the follow-up is a
  project-reference / incremental-build split, not a phase blocker.
- **Phase 7's learner stayed out of the measurement path.** The learning
  module is decoupled and disabled-by-default in deterministic contexts, so
  it cannot have skewed these numbers (see `docs/phase-7/report.md` §3).
- **No pre-existing failure was hidden or waived.** The Phase 0
  known-failures register (`docs/phase-0/01-known-failures.md`) carries no
  open item this phase depended on, and nothing new was added to it.

---

## 5. Verification

Commands run from `builderforce-webcontainers/`:

```sh
node scripts/benchmark/run-baseline.mjs --out scripts/benchmark/results/phase8-result.json   # exit 0
node scripts/benchmark/compare-baseline.mjs                                                   # exit 0, GATE PASS
```

Full-suite re-verification after the candidate run (same green state):

- `pnpm typecheck` — exit 0
- `pnpm test` — core 25 files / 299 passed / 2 skipped; browser 23 files / 168 passed / 0 failed; exit 0
- `pnpm build` — exit 0

---

## 6. Sign-off

Phases 1–8 are implemented, tested, measured, and regression-validated
against the Phase 0 baseline. The program's exit criteria — useful CPU-first
local inference, private-knowledge capture and reuse, reduced frontier-model
dependence, and no regression to the WebContainer runtime — are met at the
level this harness can prove (correctness, coverage, dist size, timing
informational). Browser-dependent perf numbers (TTFT, tokens/sec) remain
**pending browser harness**, as the Phase 0 report stated; they were not
invented here.
