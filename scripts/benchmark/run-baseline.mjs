#!/usr/bin/env node
// Phase 0 — Baseline, Test Validation, and Regression Gate.
//
// Runs the repo's existing checks (test / typecheck / build) per package,
// measures dist sizes and environment facts, and writes everything as JSON
// to scripts/benchmark/results/baseline-result.json so Phase 8 can rerun and
// diff against it. Dependency-free Node ESM; works on Windows (spawns via
// the shell so pnpm .cmd shims resolve).
//
// Usage (from the repo root):
//   node scripts/benchmark/run-baseline.mjs
//   node scripts/benchmark/run-baseline.mjs --out scripts/benchmark/results/phase8-result.json
//
// A bare run overwrites results/baseline-result.json. Pass --out to keep the
// Phase 0 baseline intact when Phase 8 reruns the same measurements.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dirStats, timeCommand } from './lib/timing.mjs';

const SCHEMA_VERSION = 1;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const defaultResultsFile = join(scriptDir, 'results', 'baseline-result.json');

// Optional `--out <path>` writes somewhere other than the Phase 0 baseline.
// A bare run keeps writing results/baseline-result.json, which a later phase
// must not overwrite — Phase 8 passes --out to protect that file.
function resolveResultsFile(argv) {
  const flag = argv.indexOf('--out');
  if (flag === -1) return defaultResultsFile;
  const value = argv[flag + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--out requires a path, e.g. --out scripts/benchmark/results/phase8-result.json');
  }
  return resolve(process.cwd(), value);
}

const PACKAGES = [
  { name: 'core', dir: 'packages/core' },
  { name: 'browser', dir: 'packages/browser' },
];

// ---------------------------------------------------------------------------
// Environment facts
// ---------------------------------------------------------------------------

async function captureEnv() {
  const node = process.version;
  const platform = process.platform;
  const arch = process.arch;

  const pnpmRes = await timeCommand('pnpm', ['--version'], repoRoot);
  const pnpm = (pnpmRes.stdout || pnpmRes.stderr).trim() || null;

  let typescript = null;
  const tsPkgPath = join(
    repoRoot,
    'packages',
    'browser',
    'node_modules',
    'typescript',
    'package.json'
  );
  try {
    const tsPkg = JSON.parse(await readFile(tsPkgPath, 'utf8'));
    typescript = tsPkg.version ?? null;
  } catch {
    typescript = null; // not installed yet — install hasn't run
  }

  return { node, platform, arch, pnpm, typescript };
}

// ---------------------------------------------------------------------------
// Vitest summary parsing
// ---------------------------------------------------------------------------

// Vitest run summary lines look like (vitest 2.x):
//   Test Files  25 passed (27)
//   Tests  299 passed (301)
// Individual skipped/failed lines only appear when non-zero, e.g.:
//   Tests  299 passed | 2 skipped (301)
function parseVitestSummary(stdout) {
  // Vitest 2.x run summary ends with two lines like:
  //   Test Files  25 passed | 2 skipped (27)
  //   Tests  299 passed (301)
  // skipped/failed segments only appear when non-zero.
  // Strip ANSI color/bold codes first — vitest colors even piped output on Windows.
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  const filesLine = lines.find((l) => /^\s*Test Files\s+/.test(l));
  const testsLine = lines.find((l) => /^\s*Tests\s+/.test(l));

  const parseLine = (line) => {
    const out = { passed: 0, failed: 0, skipped: 0, total: 0 };
    if (!line) return out;
    const total = line.match(/\((\d+)\)\s*$/);
    out.total = total ? Number(total[1]) : 0;
    const sum = (re) => {
      let n = 0;
      for (const m of line.matchAll(re)) n += Number(m[1]);
      return n;
    };
    out.passed = sum(/(\d+)\s+passed/g);
    out.failed = sum(/(\d+)\s+failed/g);
    out.skipped = sum(/(\d+)\s+skipped/g);
    return out;
  };

  return { files: parseLine(filesLine), tests: parseLine(testsLine) };
}

// ---------------------------------------------------------------------------
// Per-package runs
// ---------------------------------------------------------------------------

async function runPackageTests(pkg) {
  const cwd = join(repoRoot, pkg.dir);
  const res = await timeCommand('pnpm', ['test'], cwd);
  const summary = parseVitestSummary(res.stdout + '\n' + res.stderr);
  return {
    command: 'pnpm test',
    cwd: pkg.dir,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    ...summary,
  };
}

async function runPackageTypecheck(pkg) {
  const cwd = join(repoRoot, pkg.dir);
  const res = await timeCommand('pnpm', ['typecheck'], cwd);
  return {
    command: 'pnpm typecheck',
    cwd: pkg.dir,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
  };
}

async function measureDist(pkg) {
  const distPath = join(repoRoot, pkg.dir, 'dist');
  const stats = await dirStats(distPath);
  return { path: `${pkg.dir}/dist`, ...stats };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const resultsFile = resolveResultsFile(process.argv);
  const suiteStart = performance.now();

  console.log('Phase 0 baseline — builderforce-webcontainers');
  console.log(`repo root: ${repoRoot}`);
  console.log('');

  const env = await captureEnv();
  console.log(
    `env: node ${env.node} | pnpm ${env.pnpm} | typescript ${env.typescript} | ${env.platform}/${env.arch}`
  );

  const packages = [];
  for (const pkg of PACKAGES) {
    console.log(`\n=== ${pkg.name} (${pkg.dir}) ===`);

    const test = await runPackageTests(pkg);
    console.log(
      `  test       exit=${test.exitCode}  ${(test.durationMs / 1000).toFixed(1)}s  ` +
        `files ${test.files.passed}/${test.files.total} passed, ` +
        `tests ${test.tests.passed}/${test.tests.total} passed, ` +
        `${test.tests.skipped} skipped, ${test.tests.failed} failed`
    );

    const typecheck = await runPackageTypecheck(pkg);
    console.log(`  typecheck  exit=${typecheck.exitCode}  ${(typecheck.durationMs / 1000).toFixed(1)}s`);

    packages.push({ name: pkg.name, dir: pkg.dir, test, typecheck });
  }

  console.log('\n=== build (repo root) ===');
  const build = await timeCommand('pnpm', ['build'], repoRoot);
  console.log(`  build      exit=${build.exitCode}  ${(build.durationMs / 1000).toFixed(1)}s`);

  console.log('\n=== dist sizes ===');
  const dist = {};
  for (const pkg of PACKAGES) {
    const d = await measureDist(pkg);
    dist[pkg.name] = d;
    console.log(
      `  ${pkg.name.padEnd(8)} ${d.fileCount} files  ${(d.totalBytes / 1024).toFixed(1)} KiB  (${d.path})`
    );
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot,
    environment: env,
    suiteDurationMs: Math.round(performance.now() - suiteStart),
    packages,
    build: {
      command: 'pnpm build',
      cwd: '.',
      exitCode: build.exitCode,
      durationMs: build.durationMs,
    },
    dist,
  };

  await mkdir(dirname(resultsFile), { recursive: true });
  await writeFile(resultsFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`\nresults written to ${resultsFile}`);
  console.log('--- JSON summary ---');
  console.log(JSON.stringify(result, null, 2));

  const anyFailure =
    result.packages.some((p) => p.test.exitCode !== 0 || p.typecheck.exitCode !== 0) ||
    build.exitCode !== 0;
  process.exitCode = anyFailure ? 1 : 0;
}

main().catch((err) => {
  console.error('baseline run failed:', err);
  process.exitCode = 1;
});
