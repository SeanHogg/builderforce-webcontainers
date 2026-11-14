# Benchmark Suite — Phase 0 Baseline

Reproducible benchmark harness for `@seanhogg/builderforce-webcontainers`.
It exists so the Phase 0 measurements (tests, typecheck, build, dist size,
environment) can be **rerun and diffed** — every later phase of the
Adaptive Local AI Inference + Intelligent Memory Runtime program must be
measured against the baseline captured here, and Phase 8 reruns this exact
suite to prove no regression.

## How to run

From the **repo root** (`builderforce-webcontainers/`):

```sh
node scripts/benchmark/run-baseline.mjs
```

- Dependency-free: plain Node ESM (Node >= 18), no npm installs.
- Windows-compatible: commands spawn through a shell so `pnpm` `.cmd`
  shims resolve.
- A second run **overwrites** `results/baseline-result.json` cleanly.

Exit code is `0` only when every measured command (test, typecheck, build)
exits `0` — use it as a regression gate in CI later.

## What it measures

| Measurement | Command | Recorded |
| --- | --- | --- |
| Core tests | `pnpm test` in `packages/core` | wall-clock ms, vitest passed/failed/skipped counts for test files and tests (parsed from the summary lines) |
| Browser tests | `pnpm test` in `packages/browser` | same |
| Core typecheck | `pnpm typecheck` in `packages/core` | wall-clock ms, exit code |
| Browser typecheck | `pnpm typecheck` in `packages/browser` | wall-clock ms, exit code |
| Build | `pnpm build` from repo root | wall-clock ms, exit code |
| Dist sizes | `packages/{core,browser}/dist` | recursive file count + total bytes |
| Environment | — | platform, arch, node version, pnpm version, typescript version (from `packages/browser/node_modules/typescript/package.json` when installed) |

The run prints a human-readable summary as it goes, then the full JSON.

## Output

`results/baseline-result.json`:

```jsonc
{
  "schemaVersion": 1,          // bump when the result shape changes
  "generatedAt": "...",        // ISO timestamp
  "repoRoot": "...",
  "environment": { "node": "...", "platform": "...", "arch": "...", "pnpm": "...", "typescript": "..." },
  "suiteDurationMs": 0,        // wall-clock for the whole suite
  "packages": [
    {
      "name": "core", "dir": "packages/core",
      "test":       { "command": "pnpm test", "cwd": "...", "exitCode": 0, "durationMs": 0,
                       "files": { "passed": 0, "failed": 0, "skipped": 0, "total": 0 },
                       "tests": { "passed": 0, "failed": 0, "skipped": 0, "total": 0 } },
      "typecheck":  { "command": "pnpm typecheck", "cwd": "...", "exitCode": 0, "durationMs": 0 }
    }
    // ... same for "browser"
  ],
  "build": { "command": "pnpm build", "cwd": ".", "exitCode": 0, "durationMs": 0 },
  "dist": {
    "core":    { "path": "packages/core/dist",    "fileCount": 0, "totalBytes": 0 },
    "browser": { "path": "packages/browser/dist", "fileCount": 0, "totalBytes": 0 }
  }
}
```

`results/*.json` is gitignored (see `results/.gitignore`) — results are
local artifacts, not committed. Commit only the harness.

## What is NOT measured here (Phase 1)

Browser-dependent benchmarks land in **Phase 1**: time-to-first-token
(TTFT), tokens/sec, and WebGPU / WASM-SIMD capability probes require a
real browser harness and cannot run headless in this environment. Until
then those numbers are **pending browser harness (Phase 1)** — do not
invent them.

## How Phase 8 compares runs

1. Before the Phase 0 gate was passed, a baseline run produced
   `results/baseline-result.json` (kept locally; regenerate any time with
   the command above).
2. At Phase 8 (regression validation), rerun the same script and diff the
   new JSON against the saved baseline:
   - `packages[*].test.tests.passed/failed/skipped` and
     `packages[*].test.files.*` must be **no worse** than baseline
     (currently 352 passed / 2 skipped / 0 failed overall).
   - `exitCode` for test, typecheck, and build must all remain `0`.
   - `dist.*.fileCount` / `totalBytes` document the size cost of any
     added runtime (local inference, memory integration).
   - `durationMs` values are informational (machine-noisy); large
     regressions (> 2×) warrant investigation, not gate failure.
3. Compare only after normalizing `environment` — a different node/pnpm/
   typescript version invalidates timing and possibly count comparisons.
