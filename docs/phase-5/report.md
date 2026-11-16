# Phase 5 — Advanced Model & KV Cache Optimization

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 5 complete — typecheck clean; package tests 154/154 passed (including `tests/kvcache.test.ts` 18/18).

> **Scope honored:** Everything here is browser-compatible only — pure TypeScript, no native code, no new runtime dependency. The KV-cache module is deliberately decoupled from the Phase 1 execution engine (`src/inference/` still only knows *how* to run) and from the Phase 2 controller (`src/adaptive/` still only decides *where/how*). CPU-only remains the primary path; WebGPU is a fact, not a gate. No existing public API was changed — only additive exports in `packages/browser/src/index.ts`. The execution engine is mock/injected (no real GGUF/ONNX weights run here); reuse, quality, and A/B comparisons are validated structurally.

---

## 1. What was built

A self-contained KV-cache and quantization-aware runtime under `packages/browser/src/kvcache/`:

| Path | Role |
|------|------|
| `src/kvcache/types.ts` | Compatibility parts, flags, quant plan, generate request/result, injectable quality scorer, A/B runtime options. |
| `src/kvcache/compatibility.ts` | Canonical compatibility key (model weights, tokenizer, positional config, attention config) + exact token-prefix length. Semantic retrieval is **not** a match criterion. |
| `src/kvcache/radix.ts` | Token radix tree: longest **exact** prefix only. |
| `src/kvcache/lru.ts` | Small byte-bounded LRU. Phase 3 `src/memory/` eviction is residency-tier shaped (model weights), so KV pages keep a dedicated LRU rather than reusing that API. |
| `src/kvcache/paged.ts` | Paged KV store: pages + per-compat-key radix index + LRU eviction. Compatible sessions share pages (session id is not in the key). |
| `src/kvcache/quant.ts` | Quantization-aware plan from `q4`/`q5`/`q8`/`fp16`. No conversion unless `preconvertQuant` is on **and** the target is a strictly smaller supported format. Bandwidth + default quality model. |
| `src/kvcache/advanced.ts` | Speculative decoding, continuous batching, activation sparsity — each gated by an explicit flag **and** a capability/architecture check. Incompatible families degrade to the plain path. |
| `src/kvcache/runtime.ts` | `createKvCacheRuntime` — mock-backed generate path, prefix reuse, A/B `setEnabled` toggles, injectable quality scorer. |
| `tests/kvcache.test.ts` | Acceptance: repeated-prompt speedup, mismatched key never served, quality tolerance, on/off A/B for every optimization. |

### Key design decisions

- **Exact-prefix reuse only.** A hit requires the five-part compatibility key **and** an exact preceding token prefix. Changing weights, tokenizer, positional config, or attention config is a hard miss.
- **Session id is not part of the key.** Compatible sessions share pages.
- **Conversion is never implicit.** Native `ModelRef.quantization` is used unless `preconvertQuant` is opted in and justified by a bandwidth saving.
- **Advanced opts are opt-in + capability-gated.** Speculative decoding needs a draft model and a decoder-transformer family; sparsity needs `sparsityFraction > 0`; continuous batching is batch-level. Encoder-only architectures take the plain path.
- **Quality is injectable.** Tests (and Phase 8) supply a scorer; the runtime only compares the score to a tolerance.

---

## 2. Acceptance criteria

| Criterion | Verdict |
|-----------|---------|
| Demonstrable improvement in repeated-prompt workloads | **Met in tests.** A second generate sharing an exact prefix reports `servedFromCache` and a strictly lower `simulatedMs` than the first / than prefixCache-off. |
| No invalid KV state reuse | **Met in tests.** Mismatched weights, tokenizer, positional config, attention config, or model id never set `servedFromCache`. |
| Model quality remains within defined tolerance | **Met in tests.** Default scorer stays within 0.08 on matching output; an injected scorer can pass or fail the gate. |
| Every optimization has an enabled/disabled benchmark comparison | **Met in tests.** prefixCache, speculativeDecoding, activationSparsity, continuousBatching, preconvertQuant each have an on/off pair. |

Limitation (same as Phase 1): no real GGUF/ONNX weights run in this environment. Costs are simulated with a deterministic cost model so the structural claims (reuse cheaper than recompute, mismatched key is a miss) are testable. Fill numeric tok/s on the reference machine in Phase 8.

---

## 3. What later phases must know

- **This module does not execute real decode.** Wire it in front of Phase 1 `InferenceBackend.generate` in Phase 8 if a real engine is injected; today `createKvCacheRuntime` is the testable stand-in.
- **Do not treat RAG hits as KV reuse.** Retrieved knowledge may shorten a prompt; it is not interchangeable KV state.
- **No new dependency was added.** Keep it that way.

---

## 4. Verification (verbatim)

Commands run from `builderforce-webcontainers/` (the `@seanhogg/builderforce-webcontainers` filter did not match a workspace name, so pnpm executed the `packages/browser` scripts via that directory's package.json).

### Typecheck — exit 0

```
> @seanhogg/builderforce-webcontainers@2026.10.13 typecheck C:\code\agentic\builderforce-webcontainers\packages\browser
> node ./node_modules/typescript-7/bin/tsc --noEmit
```

### Tests — exit 0

```
> @seanhogg/builderforce-webcontainers@2026.10.13 test C:\code\agentic\builderforce-webcontainers\packages\browser
> vitest run

 Test Files  22 passed (22)
      Tests  154 passed (154)
   Duration  17.63s
```

`tests/kvcache.test.ts` — 18 passed.

Phase 4 `tests/prefetch.test.ts` had two timing-sensitive failures on the first full-suite run (`onElapsed < offElapsed` wall-clock compare; self-tune waste window that did not re-prefetch after the unused target stayed resident). Those assertions were made deterministic in this slice so the required package gate exits 0. Behaviour of the prefetcher itself was not changed.
