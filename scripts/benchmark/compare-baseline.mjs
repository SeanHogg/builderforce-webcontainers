#!/usr/bin/env node
// Phase 8 — compare a rerun against the Phase 0 baseline.
//
// Dependency-free Node ESM. Does not rerun anything: it reads two result
// files produced by run-baseline.mjs and gates on regressions.
//
// Usage (from the repo root):
//   node scripts/benchmark/compare-baseline.mjs
//   node scripts/benchmark/compare-baseline.mjs --baseline <path> --candidate <path>
//
// Defaults resolve from this script's directory, so the Phase 0 file is never
// rewritten here. Exit 0 only when the gate passes. Timing is informational:
// a duration is never called "improved" unless it is under half the baseline
// AND node/pnpm/typescript match.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(scriptDir, 'results');

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(process.cwd(), value);
}

function pct(delta, base) {
  if (!base) return null;
  return (delta / base) * 100;
}

function fmtPct(value) {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

async function load(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function comparePackage(basePkg, candPkg, failures, notes) {
  const name = candPkg?.name ?? basePkg?.name ?? 'unknown';
  if (!candPkg) {
    failures.push(`${name}: missing from candidate`);
    return null;
  }
  for (const step of ['test', 'typecheck']) {
    if (candPkg[step]?.exitCode !== 0) {
      failures.push(`${name} ${step} exitCode ${candPkg[step]?.exitCode} (must be 0)`);
    }
  }
  for (const kind of ['tests', 'files']) {
    const baseFailed = basePkg?.test?.[kind]?.failed ?? 0;
    const candFailed = candPkg.test?.[kind]?.failed ?? 0;
    if (candFailed > baseFailed) {
      failures.push(`${name} ${kind}.failed ${candFailed} > baseline ${baseFailed}`);
    }
  }
  const baseSkipped = basePkg?.test?.tests?.skipped ?? 0;
  const candSkipped = candPkg.test?.tests?.skipped ?? 0;
  if (candSkipped > baseSkipped) {
    failures.push(`${name} tests.skipped ${candSkipped} > baseline ${baseSkipped}`);
  }
  const passedDelta = (candPkg.test?.tests?.passed ?? 0) - (basePkg?.test?.tests?.passed ?? 0);
  notes.push(
    `${name} tests: baseline ${basePkg?.test?.tests?.passed ?? 0} passed / ${baseSkipped} skipped / ${basePkg?.test?.tests?.failed ?? 0} failed; ` +
      `candidate ${candPkg.test?.tests?.passed ?? 0} passed / ${candSkipped} skipped / ${candPkg.test?.tests?.failed ?? 0} failed ` +
      `(passed ${passedDelta >= 0 ? '+' : ''}${passedDelta}; added tests are coverage, not a regression)`,
  );
  return { name, passedDelta };
}

function timingNote(label, baseMs, candMs, envMatches) {
  if (typeof baseMs !== 'number' || typeof candMs !== 'number' || baseMs <= 0) {
    return `${label}: duration not comparable (missing baseline or candidate)`;
  }
  const ratio = candMs / baseMs;
  const deltaPct = pct(candMs - baseMs, baseMs);
  const conditions = envMatches ? 'environment matches' : 'environment differs — timing comparison invalid';
  if (!envMatches) {
    return `${label}: baseline ${baseMs}ms, candidate ${candMs}ms (${fmtPct(deltaPct)}). ${conditions}. No improvement claimed.`;
  }
  if (ratio < 0.5) {
    return `${label}: baseline ${baseMs}ms, candidate ${candMs}ms (${fmtPct(deltaPct)}, ratio ${ratio.toFixed(2)}). Improved: candidate is under half the baseline and ${conditions}.`;
  }
  const warn = ratio > 2 ? ' INVESTIGATE: candidate is more than 2× baseline (warning only, not a gate failure).' : '';
  return `${label}: baseline ${baseMs}ms, candidate ${candMs}ms (${fmtPct(deltaPct)}, ratio ${ratio.toFixed(2)}). Informational / within measurement noise. No improvement claimed.${warn}`;
}

async function main() {
  const baselinePath = flagValue(process.argv, '--baseline') ?? join(resultsDir, 'baseline-result.json');
  const candidatePath = flagValue(process.argv, '--candidate') ?? join(resultsDir, 'phase8-result.json');
  const outPath = join(resultsDir, 'phase8-comparison.json');

  const baseline = await load(baselinePath);
  const candidate = await load(candidatePath);
  const failures = [];
  const notes = [];

  const env = baseline.environment ?? {};
  const candEnv = candidate.environment ?? {};
  const envMatches =
    env.node === candEnv.node && env.pnpm === candEnv.pnpm && env.typescript === candEnv.typescript;
  if (!envMatches) {
    notes.push(
      `timing comparison invalid: baseline node/pnpm/typescript ${env.node}/${env.pnpm}/${env.typescript} vs candidate ${candEnv.node}/${candEnv.pnpm}/${candEnv.typescript}`,
    );
  }

  if (candidate.build?.exitCode !== 0) {
    failures.push(`build exitCode ${candidate.build?.exitCode} (must be 0)`);
  }

  const basePkgs = new Map((baseline.packages ?? []).map((p) => [p.name, p]));
  const candPkgs = new Map((candidate.packages ?? []).map((p) => [p.name, p]));
  for (const name of new Set([...basePkgs.keys(), ...candPkgs.keys()])) {
    comparePackage(basePkgs.get(name), candPkgs.get(name), failures, notes);
  }

  const timings = [];
  for (const name of basePkgs.keys()) {
    const b = basePkgs.get(name);
    const c = candPkgs.get(name);
    timings.push(timingNote(`${name} test`, b?.test?.durationMs, c?.test?.durationMs, envMatches));
    timings.push(timingNote(`${name} typecheck`, b?.typecheck?.durationMs, c?.typecheck?.durationMs, envMatches));
  }
  timings.push(timingNote('build', baseline.build?.durationMs, candidate.build?.durationMs, envMatches));
  timings.push(timingNote('suite', baseline.suiteDurationMs, candidate.suiteDurationMs, envMatches));

  const dist = {};
  for (const name of new Set([...Object.keys(baseline.dist ?? {}), ...Object.keys(candidate.dist ?? {})])) {
    const b = baseline.dist?.[name] ?? { fileCount: 0, totalBytes: 0 };
    const c = candidate.dist?.[name] ?? { fileCount: 0, totalBytes: 0 };
    const bytesDelta = c.totalBytes - b.totalBytes;
    const filesDelta = c.fileCount - b.fileCount;
    dist[name] = {
      baseline: b,
      candidate: c,
      fileCountDelta: filesDelta,
      bytesDelta,
      bytesPct: pct(bytesDelta, b.totalBytes),
    };
    notes.push(
      `${name} dist: ${b.fileCount} files / ${b.totalBytes} bytes → ${c.fileCount} files / ${c.totalBytes} bytes ` +
        `(files ${filesDelta >= 0 ? '+' : ''}${filesDelta}, bytes ${bytesDelta >= 0 ? '+' : ''}${bytesDelta} / ${fmtPct(dist[name].bytesPct)}). ` +
        `Growth is expected from added modules and is not a gate failure.`,
    );
  }

  const comparison = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselinePath,
    candidatePath,
    baselineGeneratedAt: baseline.generatedAt ?? null,
    candidateGeneratedAt: candidate.generatedAt ?? null,
    environmentMatches: envMatches,
    gate: failures.length === 0 ? 'pass' : 'fail',
    failures,
    notes,
    timings,
    dist,
    conditions: {
      baseline: env,
      candidate: candEnv,
    },
  };

  console.log('Phase 8 baseline comparison');
  console.log(`baseline:  ${baselinePath} (${baseline.generatedAt ?? 'unknown'})`);
  console.log(`candidate: ${candidatePath} (${candidate.generatedAt ?? 'unknown'})`);
  console.log('');
  for (const line of notes) console.log(`  ${line}`);
  console.log('');
  console.log('timings (informational — no improvement claimed unless noted):');
  for (const line of timings) console.log(`  ${line}`);
  console.log('');
  if (failures.length === 0) {
    console.log('GATE PASS');
  } else {
    console.log('GATE FAIL');
    for (const line of failures) console.log(`  - ${line}`);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(comparison, null, 2) + '\n', 'utf8');
  console.log(`\ncomparison written to ${outPath}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('compare-baseline failed:', err);
  process.exitCode = 1;
});
