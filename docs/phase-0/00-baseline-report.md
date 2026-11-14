# Phase 0 — Baseline, Test Validation, and Regression Gate

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers` (branch `main`, clean, in sync with origin)
**Companion repo measured:** `builderforce-memory` (branch `main`, ahead 2 of origin — documented only, not pushed)
**Date:** 2026-11-14
**Status:** Phase 0 complete — regression gate PASSED with one documented pre-existing defect (see `01-known-failures.md`)

> **Execution rule honored:** No implementation code was changed in this phase. Every number below was measured by running the suites; nothing was estimated or invented. All browser-dependent inference benchmarks are marked **PENDING — browser harness (Phase 1)** because this environment (Windows, Node ≥ 18, pnpm 9.1.0) has no headless browser harness for TTFT / tokens-per-second / WebGPU capability probes.

---

## 0.1 Implementation inventory

### WebContainer architecture (packages/browser)

Verified by listing `packages/browser/src` / `packages/core/src` and targeted search.

**Service worker layer**
- `sw.ts` — service worker entry
- `swRouter.ts` — request routing inside the service worker

**Node process host / worker layer** (`packages/browser/src/node/`)
- `processHost.ts`, `worker.ts`, `workerProcess.ts`, `childRelay.ts`, `portResponder.ts`, `responseWire.ts`, `protocol.ts`

**Type-checking**
- `check/worker.ts`, `check/cachedFetch.ts` — dedicated TS typecheck worker

**Other runtime modules**
- `relayWorker.ts`, `worker.ts`
- `snapshotStore.ts` — snapshot persistence
- `packageCache.ts` — package caching
- `esbuildWasm.ts` — WASM bundler integration
- `transport.ts` — postMessage transport
- `previewBridge.ts`, `previewMessages.ts`, `previewUpdates.ts` — live preview channel
- `componentCompilers.ts` (Vue / Svelte), `styleCompilers.ts`
- `devServer` (in `packages/core`) — dev server; sets `COEP: credentialless` on documents only

**Browser APIs used**
- Web Workers
- Service Worker
- IndexedDB (`fake-indexeddb` in tests)
- postMessage ports

**COOP/COEP:** explicitly NOT required — README states "no COOP/COEP, no session caps". Dev server sets `COEP: credentialless` on documents only.

### WebContainers package configuration

| Package | Name@Version |
|---|---|
| `packages/core` | `@seanhogg/builderforce-webcontainers-core@2026.10.13` |
| `packages/browser` | `@seanhogg/builderforce-webcontainers@2026.10.13` |

- **Only runtime dependency of the browser package:** `esbuild-wasm ^0.24.0`
- Dev: typescript 5.9.3 + typescript-7, vitest ^2.1.0, esbuild ^0.24.0, fake-indexeddb ^6, @vue/compiler-sfc, svelte ^5
- Scripts: `build`, `test`, `typecheck`, `clean`, `release:check`. **No lint script in this repo.**

### BuilderForce Memory repo inventory (`builderforce-memory`, 3 packages)

| Package | Name@Version | Role |
|---|---|---|
| `packages/memory-engine` | `@seanhogg/builderforce-memory-engine@2026.10.65` | TS/WGSL Mamba SSM kernels, model blocks, autograd, training, BPE tokenizer; zero runtime deps; WebGPU-native |
| `packages/memory` | `@seanhogg/builderforce-memory@2026.10.80` | Runtime: SSM execution, Transformer orchestration, online distillation, enterprise RAG (ingestion pipelines, vector-store adapters, tenant/ACL hybrid retrieval), knowledge layer (`src/knowledge`, 161 files), retrieval (30), working memory, evermind, telemetry. Jest coverage thresholds: statements 90 / branches 85 / functions 95 / lines 92 |
| `packages/memory-mcp` | `@seanhogg/builderforce-memory-mcp@2026.10.80` | MCP server: `memory_save` / `memory_recall` / `memory_restore`, local lexical + CPU SSM embedding ranker, evermind embedder package loading, gateway cost tools |

Package keywords (`mamba`, `ssm`, `webgpu`, `distillation`, `online-learning`, `browser-ai`) confirm the CPU-first + optional WebGPU direction is already established.

### Existing inference / memory capabilities relevant to later phases

Verified via `docs/ml-task-catalog.md` and package metadata:

- **`EvermindTextEmbedder`** (`lm/text_embedder.ts`) — text→vector on CPU, no GPU, no network. Already the Phase 6 embedding primitive.
- **`LimbicModel` + `LimbicTrainer`** (`limbic/`) — small head over an experience embedding, AdamW, GPU when present else CPU.
- **`docs/ml-task-catalog.md`** defines an aspirational engine-tier abstraction: `MlEngineRef[]` in preference order, `{ tier: 'local'; engine: 'onnx'; model: string }` (transformers.js, WASM CPU or WebGPU) — described as a LATER tier behind current SSM work. **Classification: design intent, not implemented code.**
- memory-mcp tests confirm: LRU-bounded vector cache persisted across process restarts; cache discarded when written by a different model; corrupt cache ignored (not fatal); embedded tokenizer with no file on disk.

---

## 0.2 Test results

### builderforce-webcontainers — `pnpm test` (vitest 2.1.9), run from repo root

| Suite | Files | Passed | Skipped | Failed | Wall time |
|---|---|---|---|---|---|
| core | 25 passed, 2 skipped | **299 / 301** | 2 (`tests/e2e/express.test.ts`, `tests/e2e/sveltekit.test.ts`, 1 test each) | 0 | ~31.5 s |
| browser | 11 | **53 / 53** | 0 | 0 | ~12.5 s |
| **Total** | — | **352** | **2** | **0** | ~44 s |

- `pnpm install` — lockfile up to date, 2.2 s.
- `pnpm typecheck` (typescript-7 `tsc --noEmit`) — both packages clean.
- `pnpm build` (typescript-7 `tsc -p tsconfig.build.json` + `build-sw.mjs`) — clean.

### builderforce-memory — `pnpm test`, run from repo root

| Package | Suites | Result |
|---|---|---|
| memory-engine | 36 / 36 | PASS |
| memory (jest, ts-jest ESM, coverage thresholds 90/85/95/92) | 165 / 165 | PASS |
| memory-mcp | 71 / 71 | PASS, 0 fail |

- `pnpm install` — clean (runs memory-engine prepare build).
- `pnpm build` (tsc each package) — clean.
- `pnpm typecheck` — **no root `typecheck` script** (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`); type-checking is covered by the tsc build. See known failures.
- `pnpm lint` — **FAILS, 1 pre-existing error** (`packages/memory/src/knowledge/build.ts:294:15` prefer-const). See known failures.

### Classification table (PRD categories)

| # | Category | Item | Disposition |
|---|---|---|---|
| 1 | Pre-existing defect | memory lint error: `packages/memory/src/knowledge/build.ts:294:15` — prefer-const (`'from'` is never reassigned); `pnpm lint` in builderforce-memory exits 1 | Documented, NOT fixed in Phase 0; file as its own ticket |
| 1 | Pre-existing defect (warnings) | ~15 unused-var warnings in memory (`_` / `_drop` / `_b`, unused `EXTRACTOR_VERSION` import, unused jest/VectorMatch imports in tests); 3 warnings in memory-engine | Documented only |
| 2 | Gap (missing capability) | builderforce-memory has no root `typecheck` script (`pnpm typecheck` → `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`); type-check covered by tsc build | Documented as gap |
| 3 | Environment-dependent | webcontainers `tests/e2e/express.test.ts` and `tests/e2e/sveltekit.test.ts` skipped — require a browser environment | Skipped by design; re-run under browser harness in Phase 1 |
| 4 | None — gate clean | All 352 webcontainers tests pass; all memory / engine / mcp suites pass; webcontainers typecheck + both repos' builds clean | Regression gate baseline |

---

## 0.3 / 0.4 Performance benchmarks

**No browser harness exists in this environment.** Every browser-dependent inference benchmark below is **PENDING — browser harness (Phase 1)**. No numbers were invented.

| Benchmark | Status | Notes |
|---|---|---|
| TTFT (time to first token) | PENDING — browser harness (Phase 1) | Requires in-browser inference run |
| Tokens / second (decode) | PENDING — browser harness (Phase 1) | — |
| Prompt / prefill throughput | PENDING — browser harness (Phase 1) | — |
| Peak memory during inference | PENDING — browser harness (Phase 1) | — |
| CPU utilization during inference | PENDING — browser harness (Phase 1) | — |
| Model download / cache behavior | PENDING — browser harness (Phase 1) | — |
| WebContainer startup time | PENDING — browser harness (Phase 1) | — |
| Memory ingestion latency | PENDING — browser harness (Phase 1) | — |
| Embedding latency | PENDING — browser harness (Phase 1) | CPU primitive exists (`EvermindTextEmbedder`); measurement harness needed |
| Retrieval latency | PENDING — browser harness (Phase 1) | — |
| Recall@5 | PENDING — browser harness (Phase 1) | — |

### Environment facts that ARE known (measured, not invented)

- OS: **Windows**
- Node: **>= 18**
- pnpm: **9.1.0**
- TypeScript: **5.9.3** in webcontainers; webcontainers also carries **typescript-7**; builderforce-memory carries **@typescript/typescript6 + typescript-7**
- Test runner: **vitest 2.1.9** (webcontainers); **jest (ts-jest ESM)** (memory)
- Sole runtime dependency of the webcontainers browser package: **esbuild-wasm ^0.24.0**
- memory-engine: **zero runtime deps**

### Build artifact sizes (measured)

| Package | Files | Size |
|---|---|---|
| webcontainers browser dist | 111 | 1329 KiB |
| webcontainers core dist | 540 | 3049 KiB |
| memory dist | 1104 | 6029 KiB |
| memory-engine dist | 476 | 2883 KiB |
| memory-mcp dist | 128 | 705 KiB |

---

## 0.5 Baseline report conclusions

### Key findings

1. **Zero existing local-AI-inference code in webcontainers.** Searches for `transformers`, `onnx`, `wllama`, `webllm`, `gguf`, and WASM-inference terms returned **0 matches**. The only "embedding" hits are `sass-embedded` and COEP headers. → **Phases 1–5 are greenfield**, and the 352-test suite is the regression gate.
2. **Memory already has CPU text embedding** (`EvermindTextEmbedder`), `LimbicModel` / `LimbicTrainer` (CPU/GPU), and a persisted LRU vector cache proven by memory-mcp tests — primitives Phases 2–6 build on, not code to be replaced.
3. **The `{ tier: 'local'; engine: 'onnx' }` tier in `ml-task-catalog.md` is documented design intent, not implemented code.** It should be treated as the target shape for the local tier, behind the existing SSM work.
4. **Regression gate: PASSED.** 352 webcontainers tests + all memory/engine/mcp suites pass; webcontainers typecheck and both repos' builds are clean. One pre-existing lint error in builderforce-memory is documented (not fixed) and must be filed as its own ticket.

### Exit-criteria checklist

| Phase 0 exit criterion | Status |
|---|---|
| 0.1 Current implementation inspected; architecture, tests, and Memory integration inventoried | MET |
| 0.2 Existing test suites run and results recorded | MET — 352 passed / 2 skipped / 0 failed (webcontainers); 36/36, 165/165, 71/71 (memory) |
| 0.3 Performance baseline measured where the environment allows | PARTIAL — environment facts, dist sizes, and test timings measured; all browser-dependent inference metrics PENDING browser harness (Phase 1) |
| 0.4 Known failures classified and documented | MET — 3 items registered in `01-known-failures.md` |
| 0.5 Baseline report authored with conclusions and regression gate verdict | MET — this document |

### Regression gate verdict

**GATE PASSED** with one documented pre-existing defect. Nothing may regress below this state. The memory lint error is not a Phase 0 fix target; it is registered in `01-known-failures.md` and must be filed as a separate ticket.
