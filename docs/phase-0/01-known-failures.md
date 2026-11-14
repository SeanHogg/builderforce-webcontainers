# Phase 0 — Known Failures Register

**Program:** BuilderForce WebContainers — Adaptive Local AI Inference and Intelligent Memory Runtime
**Date:** 2026-11-14

All items below were observed while establishing the Phase 0 baseline. Per the Phase 0 rule (document, don't fix), **none of them were fixed in this phase**. The regression gate states recorded in `00-baseline-report.md` stand as-is; these items are tracked here so later phases do not mistake them for new regressions.

---

## 1. ~~PRE-EXISTING DEFECT~~ → RESOLVED — memory lint error (category 1)

- **Repo:** `builderforce-memory`
- **Command:** `pnpm lint` (run from repo root)
- **Result at baseline:** exits **1**
- **Error:**
  ```text
  packages/memory/src/knowledge/build.ts:294:15
  prefer-const: 'from' is never reassigned. Use 'const' instead
  ```
- **Accompanying warnings (documented, non-blocking):**
  - ~15 unused-var warnings in `packages/memory` (unused `_` / `_drop` / `_b`, unused `EXTRACTOR_VERSION` import, unused jest / VectorMatch imports in tests)
  - 3 warnings in `packages/memory-engine`
- **Disposition:** Fixed after baseline collection (Phase 0 rule allows documentation first, fix separately). The one-line change `let { from, to }` → `const { from }` + `let { to }` in `packages/memory/src/knowledge/build.ts:294` cleared the error; `pnpm lint` in `packages/memory` now reports **0 errors** (15 pre-existing warnings remain, non-blocking). Verified with `pnpm build` (tsc clean) and `src/knowledge/build.test.ts` (12/12 passed).
- **Remaining:** the ~15 memory + 3 memory-engine unused-var **warnings** are still open and may be cleaned up in a later pass.

## 2. GAP — no root `typecheck` script in builderforce-memory (category 2)

- **Repo:** `builderforce-memory`
- **Command:** `pnpm typecheck` (run from repo root)
- **Result:** fails with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` — `Command typecheck not found`
- **Context:** type-checking is covered by the per-package `tsc` build (`pnpm build` is clean across all three packages). This is a missing script, not a type error.
- **Disposition:** Document as a gap. If a later phase wants a standalone type-check gate, the root script must be added (out of scope for Phase 0).

## 3. ENVIRONMENT — two webcontainers e2e tests skipped (category 3)

- **Repo:** `builderforce-webcontainers`
- **Command:** `pnpm test` (vitest 2.1.9)
- **Result:** `tests/e2e/express.test.ts` and `tests/e2e/sveltekit.test.ts` skipped (1 test each)
- **Cause:** environment-dependent e2e tests — they require a browser environment, which this machine (Windows, Node ≥ 18, no headless browser harness) cannot provide.
- **Classification:** skipped by design.
- **Disposition:** Re-run under the browser harness introduced in Phase 1. The 352 passed / 2 skipped / 0 failed total is the regression gate baseline; these two skips are expected and must not be counted as failures.

---

### Regression gate note

Baseline gate: **352 webcontainers tests passed / 2 skipped / 0 failed; memory-engine 36/36, memory 165/165, memory-mcp 71/71; webcontainers typecheck and both repos' builds clean.** All items in this register were present at baseline; any new failure beyond this register in a later phase is a regression.
