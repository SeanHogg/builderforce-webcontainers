# Phase 3 — Hierarchical Memory & Residency Management

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 3 complete — typecheck clean, package tests 114 passed / 0 failed (18 of them new residency tests)

> **Scope honored:** Everything here is browser-compatible only — pure TypeScript plus the existing IndexedDB `ModelCache`. No native code, no new runtime dependency. CPU-only is the primary path (system RAM + browser storage). SharedArrayBuffer and WebGPU/VRAM are optional probed facts, never gates. The module does not decide *when* to run — that stays with the Phase 2 controller. No existing public API was changed — only additive exports in `packages/browser/src/index.ts`.

---

## 1. What was built

A self-contained residency manager under `packages/browser/src/residency/`:

| Path | Role |
|------|------|
| `src/residency/types.ts` | `ResidentEntry`, `TrackedEntry`, `EvictionStrategy`, `Quota`, `MemoryPressure`, `ResidencyStats`, `MemoryManagerConfig`. |
| `src/residency/eviction.ts` | Pluggable strategies: `lruStrategy`, `lfuStrategy`, `arcStrategy`, `costAwareStrategy` (default). `retentionValue` = `(reuseProbability * reloadCostMs) / footprint`. |
| `src/residency/estimates.ts` | `estimateWeightBytes`, `estimateReloadCostMs`, `estimateReuseProbability`. Pure; the manager does not have to call them. |
| `src/residency/pressure.ts` | `detectPressure`, `planWorkspace`. Grow on hit, shrink under pressure, always inside `[min, max]` and the residual byte budget. |
| `src/residency/storageSink.ts` | `createModelCacheSink` adapts the Phase 1 `ModelCache` (IndexedDB or `createMemoryModelCache`). `createMemorySink` for tests. Does not open a second database. |
| `src/residency/manager.ts` | `createMemoryManager`. Hard `byteBudget`, per-group/per-component quotas, transactional eviction, bounded spill retention, `hitRate()`, `pressure()`, `stats()`. |
| `tests/memory-residency.test.ts` | Strategy order, hit rate, repeated-workload benefit, hard budget, no unbounded growth, eviction does not corrupt a live entry, quotas, cost-aware retention, workspace shrink, IndexedDB spill/reload. |

### Key design decisions

- **The hard cap is the RAM/VRAM resident set plus the workspace.** `stats().usedBytes <= byteBudget` after every public call. Eviction is chosen *before* any entry is dropped, so a rejected admission cannot corrupt or drop an in-use resident.
- **Eviction is injected.** LRU, LFU, ARC, and cost-aware all implement `EvictionStrategy.rank`. Cost-aware is the default because it weighs reuse probability against reload cost relative to footprint, which is what a weight cache actually cares about.
- **CPU-only uses RAM + the Phase 1 cache.** `createModelCacheSink` writes through `createModelCache` / `createMemoryModelCache`. Spilled bytes are not charged against the RAM budget, and they are themselves capped by `storageBudgetBytes` (default `4 * byteBudget`, or the probed storage quota when one is set).
- **VRAM is a hint.** `vramBudgetBytes: 0` (the default) forces every `vram` admission back to `ram`. A non-zero hint is reported on `pressure().vramBytes` and allows a `vram` tier; it is never required to admit or run.
- **Decoupled from execution.** Nothing in `src/residency/` imports the controller or a backend. The controller may read `pressure()` / `stats()` later; this module never calls it.

---

## 2. Gate results (verbatim)

Run from `builderforce-webcontainers` after the Phase 3 change. The pnpm filter line prints a workspace-root warning and then runs the package script; both commands exited 0.

**`pnpm --filter @seanhogg/builderforce-webcontainers typecheck`** — exit 0:
```
No projects matched the filters "c:\code\agentic\builderforce-webcontainers" in "C:\code\agentic\builderforce-webcontainers"

> @seanhogg/builderforce-webcontainers@2026.10.13 typecheck C:\code\agentic\builderforce-webcontainers\packages\browser
> node ./node_modules/typescript-7/bin/tsc --noEmit
```

**`pnpm --filter @seanhogg/builderforce-webcontainers test`** — vitest 2.1.9, exit 0:
```
Test Files  20 passed (20)
     Tests  114 passed (114)
```
`tests/memory-residency.test.ts` is 18 passed. No new failures.

---

## 3. What Phase 4 must know

- **Residency does not schedule.** Phase 4 (KV-cache / model optimization, or whatever consumes this) should call `createMemoryManager` and pass the chosen `EvictionStrategy`. Do not teach `src/residency/` when to generate.
- **Admit whole layers, not slices of a buffer.** Eviction drops an entry or leaves it untouched. A KV page or layer that must stay consistent belongs in one `ResidentEntry` with an opaque `payload`.
- **`hitRate()` is hits / (hits + misses) on `get`.** A spill reload is a miss until `reload()` brings it back. Repeated workloads that touch the same id before the budget evicts it show `hitRate > 0`.
- **Storage spill is best-effort and bounded.** Pass `storage: createModelCacheSink({ cache })` with the same `ModelCache` Phase 1 already uses. Set `storageBudgetBytes: 0` to disable retention.
- **No new dependency was added.** Keep it that way.
