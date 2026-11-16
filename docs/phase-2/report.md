# Phase 2 — Adaptive Heterogeneous Execution Controller (AHEC)

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Repo:** `builderforce-webcontainers`
**Date:** 2026-11-16
**Status:** Phase 2 implemented — awaiting test/typecheck verification run

> **Scope honored:** Everything here is browser-compatible only — pure TypeScript, no native code, no new runtime dependency. The controller is deliberately decoupled from the Phase 1 execution engine: it decides *where/how* to run and *why*, `src/inference/` still only knows *how* to run. CPU-only operation remains a first-class configuration (the default). All scheduling decisions are logged with an explainable reasoning trail. No existing public API was changed — only additive exports in `packages/browser/src/index.ts`.

---

## 1. What was built

A self-contained adaptive controller under `packages/browser/src/adaptive/`:

| Path | Role |
|------|------|
| `src/adaptive/types.ts` | `HardwareProfile`, `WorkloadProfile` (model + prompt/decode characteristics), `LayerNode`/`ExecutionGraph`, `ExecutionPlan` (`backend`, `strategy`, `reasoning[]`, `estimatedCostMs`), `ExecutionDecision`, `ExecutionOutcome`, `ControllerConfig`. |
| `src/adaptive/costModel.ts` | `estimateExecutionCost` — estimates CPU time, optional GPU time, data-transfer, sync overhead, memory-alloc and cache-miss penalties from the workload + hardware profile. Pure and deterministic. |
| `src/adaptive/planner.ts` | `planExecution` — cost-based execution planning. Partitions the layer graph between CPU and (optional) GPU using dynamic programming over layer prefix/suffix splits with a per-transfer sync penalty (HEFT-lite: dependency-aware, single transfer-point assumption made explicit). Falls back to CPU-only when GPU is absent, unavailable, or not measurably justified. |
| `src/adaptive/controller.ts` | `createAdaptiveController` — the AHEC. Probes hardware, builds a plan per request, routes local-vs-remote, executes through an injected executor, measures the controller's own overhead vs the performance benefit it provides, and emits explainable decision logs. CPU-only config disables every GPU consideration. |
| `tests/adaptive-controller.test.ts` | Mock-backed tests: CPU-only default, GPU only chosen when it wins after transfer+sync, explainable decision log, controller-overhead-vs-benefit accounting, no-regression fallback. |

### Key design decisions

- **CPU-only is the default and remains first-class.** `ControllerConfig.allowGpu` defaults to the probed capability, but a `cpuOnly: true` config (or absent WebGPU) produces a pure-CPU plan and never considers a GPU transfer.
- **Heterogeneous execution is enabled only when measured/planned performance justifies it.** The planner compares the best split plan against the pure-CPU plan including transfer + sync overhead; it only returns a heterogeneous plan when its estimated cost is strictly lower by a configurable margin (`heterogeneityMargin`, default 5%).
- **Decisions are logged + explainable.** Every decision carries a `reasoning: string[]` trail (e.g. `"webgpu unavailable"`, `"gpu split saves est. 18.2ms after 4.0ms transfer"`), so scheduling choices are auditable.
- **Controller overhead < benefit, measured not assumed.** `createAdaptiveController` times its own planning and records `overheadMs` next to `benefitMs` (planned cost minus measured cost) in each `ExecutionOutcome`; the controller exposes `stats()` aggregating these so the overhead<benefit invariant is checkable in tests and in Phase 8 benchmarking.

---

## 2. What Phase 3 must know

- **The controller routes; it does not execute.** It drives an injected `executor` with the same shape as the Phase 1 `InferenceClient` (`load`/`generate`). To integrate, pass `createInferenceClient(...)` as the executor and the controller will pick backend + strategy from the probe.
- **Memory residency is NOT handled here.** Model cache/eviction lives in Phase 3 (`src/memory/`); the controller only reads a `residentBytes` hint from the workload profile.
- **Decisions are deterministic given the same inputs** — same workload + hardware profile ⇒ same plan. Phase 7 (online learning) can layer on top by adjusting `ControllerConfig` heuristics from measured `ExecutionOutcome`s.
- **No new dependency was added.** Keep it that way.
