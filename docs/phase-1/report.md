# Phase 1 — Local CPU Inference Engine

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-15
**Status:** Phase 1 complete — regression gate PASSED (371 passed / 2 skipped / 0 failed, up from the 352-passed Phase 0 baseline by exactly the 19 new inference tests)

> **Scope honored:** Everything here is browser-compatible only — TypeScript / WebAssembly / Web Workers / IndexedDB. No native binaries, no Docker, no Linux-only assumptions. SharedArrayBuffer and cross-origin isolation are treated as OPTIONAL capabilities (probed and reported, never assumed). CPU-only operation is the primary path; WebGPU is an optional adapter, not a dependency. The inference execution engine is deliberately kept separate from any adaptive controller — nothing in `src/inference/` decides *when* to run; it only knows *how* to run. No existing public API was changed (only additive exports in `packages/browser/src/index.ts`). No new runtime dependency was added — the heavy inference backend is an **injected module**, not an import (see §2).

---

## 1. What was built

A self-contained local inference runtime under `packages/browser/src/inference/`, with four pluggable backends and a worker-based host so the UI/main thread is never blocked.

### Files

| Path | Role |
|------|------|
| `src/inference/types.ts` | `InferenceBackend` abstraction, `InferenceModel`/`InferenceToken`/`GenerationStats`, `ModelRef` (id / paramsB / quantization), `RuntimeCapabilities`, `BackendInfo`. |
| `src/inference/protocol.ts` | Worker message contract: `inference:{probe,load,generate,cancel,dispose-model,token,done,error,log}`. |
| `src/inference/worker.ts` | `startInferenceWorkerHost` — runs inside a Worker; receives protocol messages, drives the selected backend, streams tokens back, aborts on cancel. |
| `src/inference/workerEntry.ts` | Worker entry, bundled to `dist/inference/worker.js`. Lists backends in preference order. |
| `src/inference/client.ts` | `createInferenceClient` — host-side API: `load()` (fetch → cache → transfer), `generate()` (async-iterable token stream + `stats`), `probe()`, `cancel()`, `dispose()`. Spawns the worker. |
| `src/inference/modelCache.ts` | IndexedDB-backed `createModelCache` (+ `createMemoryModelCache` for tests/offline). Persists weights so a reload needs no network. |
| `src/inference/capabilities.ts` | `probeRuntimeCapabilities` — wasm, WASM **SIMD** (via a v128 `WebAssembly.validate` probe), WebGPU, cross-origin isolation, SharedArrayBuffer. Facts, not gates. |
| `src/inference/backends/onnx.ts` | **Primary** CPU-first backend adapter over an injected `onnxruntime-web` wasm module. Dependency-free (module is injected via `loadModule`). |
| `src/inference/backends/wllama.ts` | llama.cpp-WASM adapter (Q4/Q5/Q8 GGUF) over an injected `wllama` module. |
| `src/inference/backends/webllm.ts` | WebLLM adapter (WebGPU) — optional; `probe()` reports `available:false` without WebGPU. |
| `src/inference/backends/mock.ts` | Deterministic mock backend for headless tests and offline paths. |

Also wired: `src/index.ts` exports the public surface (additive); `scripts/build-sw.mjs` bundles the worker to `dist/inference/worker.js` beside `dist/index.js`.

### Tests (19 new, all passing)

| Path | Covers |
|------|--------|
| `tests/inference-modelCache.test.ts` | IndexedDB round-trip (uses the already-present `fake-indexeddb` dev dependency), has/keys/delete, memory cache. |
| `tests/inference-backends.test.ts` | Mock determinism + abort; ONNX/wllama adapters streaming through an injected module; WebLLM unavailable-without-WebGPU; `renderChatPrompt`. |
| `tests/inference-capabilities.test.ts` | Probe never throws; SIMD/SAB/isolation reported as facts. |
| `tests/inference-worker.test.ts` | **Client ↔ worker host over a real `MessageChannel`** (headless): probe, load+stream+stats, **offline reload from cache with a fetch that throws**, **transfer does not detach cached bytes**, cancel stops generation, worker errors surface through the iterator. |

---

## 2. Backend decision

**Primary: ONNX Runtime Web (CPU), behind an injected-module adapter.**
**Secondary: llama.cpp WASM (Wllama). Optional: WebLLM (WebGPU only — explicitly NOT required for core functionality).**

### Tradeoff

| Candidate | CPU path | Quantized 1B–4B | WASM SIMD | Browser-only | Bundle / dep |
|-----------|----------|-----------------|-----------|--------------|--------------|
| **ONNX Runtime Web** | ✅ first-class | ✅ via ONNX quantized models (Q4/Q5/Q8 through dynamic quant) | ✅ `wasm-simd` | ✅ | host provides `onnxruntime-web`; we add **no** dependency |
| **Wllama / llama.cpp WASM** | ✅ | ✅ native GGUF Q4_K_M / Q5 / Q8 | ✅ | ✅ (single `.wasm`) | larger; threading wants SAB |
| **WebLLM** | ❌ WebGPU only | ✅ | n/a | ✅ | large; requires WebGPU |

**Why ONNX first:** it is the most portable CPU path, has first-class WASM-SIMD, runs single-threaded without SharedArrayBuffer (so it works in the least-capable browser), and — decisively for this repo — its engine can be **injected** rather than imported. That keeps the core `packages/browser` package dependency-free and preserves the existing public API and bundle size, satisfying the "measure any new dependency before adding it" rule (a real `onnxruntime-web` is a host-app concern, not added here). **Wllama** is the strongest alternative for true GGUF Q4/Q5/Q8 quality-per-byte and stays as a first-class adapter; it becomes preferable where SharedArrayBuffer is available for multi-thread decode. **WebLLM** is retained only as an optional adapter behind a `webgpu` capability check and is never required for the CPU path.

### Quantization (Q4 / Q5 / Q8)

All three are represented in the `ModelRef.quantization` contract and mapped onto each backend (ONNX dynamic quant; GGUF K-quants for Wllama). The 1B–4B target range is a first-class `paramsB` field so Phase 5 (model & KV-cache optimization) can route by size.

---

## 3. Gate results (verbatim)

Run from the repo root (`builderforce-webcontainers`) after the Phase 1 change.

**`pnpm typecheck`** — clean:
```
packages/core typecheck: Done
packages/browser typecheck: Done
```

**`pnpm build`** — clean (core `tsc -p tsconfig.build.json`, then browser `tsc` + `build-sw.mjs`, which now also emits `dist/inference/worker.js`).

**`pnpm test`** — vitest 2.1.9:
```
packages/core   Test Files  25 passed | 2 skipped (27)   Tests  299 passed | 2 skipped (301)
packages/browser Test Files 15 passed (15)              Tests  72 passed (72)
```
**Total: 371 passed / 2 skipped / 0 failed.** The 2 skips are the pre-existing browser-harness-only e2e skips recorded in `docs/phase-0/01-known-failures.md`. Against the 352-passed Phase 0 baseline this is **+19 (all new inference tests), 0 new failures** — the regression gate holds.

---

## 4. Acceptance criteria

| Criterion | Verdict |
|-----------|---------|
| Representative 1B Q4 model runs locally | **Path implemented + fixture/mock-backed.** A `ModelRef { paramsB:~1.1, quantization:'q4' }` loads through fetch→cache→worker→backend and streams. **Limitation:** no real GGUF/onnx weights can be downloaded or executed in this environment (no browser, no model registry access), so real-weight end-to-end is validated structurally, not numerically. The mock backend is deterministic and the ONNX/wllama adapters are exercised through an injected module standing in for the engine. |
| ≥ 5 tokens/sec on the reference machine | **PENDING — browser harness.** The mock backend reports a `tokensPerSecond` stat through `GenerationStats`, and the stat path is tested, but real tok/s needs a browser + real model (Phase 0 flagged this environment has no headless browser harness). Recorded conditions to be filled on the reference machine. |
| Short-prompt TTFT < 5s after model load | **PENDING — browser harness.** `ttftMs` is measured and returned in `GenerationStats` and asserted in tests; the < 5s number needs a browser run. |
| Inference does not block the main thread | **Met by architecture.** All generation runs inside a dedicated Worker (`startInferenceWorkerHost`); the client only receives streamed tokens. Verified by the MessageChannel client↔worker test running on non-worker threads. |
| No remote inference calls after provisioning | **Met + tested.** `generate()` performs no network I/O; the offline test reloads from cache with a `fetchModel` that throws and succeeds. Caching is IndexedDB-backed so a page reload is also offline-safe. |
| Existing WebContainer tests still pass (352 gate) | **Met: 371 passed / 2 skipped / 0 failed** (352 baseline + 19 new; 0 regressions). |

---

## 5. What Phase 2 must know

- **The runtime is execution-only; it does not decide.** Phase 2's Adaptive Heterogeneous Execution Controller should treat `createInferenceClient` as the local-execution primitive and route to it (vs. remote/cloud) based on its `probe()` capabilities and `GenerationStats` — the seams are already there.
- **Inject the real engine in `workerEntry.ts`.** Today the worker runs the mock backend. To go live, a host app that installs `onnxruntime-web` (or `wllama`) wires its `loadModule` into the backend list in `workerEntry.ts`; nothing else changes. The adapters and selection logic are already written and tested.
- **Offline + cache semantics are settled and tested.** `load()` = fetch (or injected `fetchModel`) → IndexedDB cache → transfer to worker. Cached bytes are copied on transfer (detachment-safe), so a later `load()` can be fully offline. Reuse `createModelCache`; don't reinvent residency here — that's Phase 3.
- **Capability facts to route on** come from `probeRuntimeCapabilities()` / client `probe()`: `wasm`, `wasmSimd`, `webgpu`, `crossOriginIsolated`, `sharedArrayBuffer`. CPU-only is always available; WebGPU is opportunistic.
- **No new dependency was added.** Keep it that way until a measured need arises; if a real engine is added later, record its size/compat/perf here per the engineering rules.
- **Perf numbers are intentionally not fabricated.** Fill in tok/s and TTFT on the documented reference machine in Phase 8's integrated benchmark; the measurement plumbing (`GenerationStats.ttftMs`, `tokensPerSecond`) already exists.
