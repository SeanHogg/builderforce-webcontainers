// Build the Rust runtime's fixtures (PRD 31 §W9 phase 6d): prebuilt wasm32-wasip1 modules the
// integration tests run — never part of the npm package. Needs rustup with the wasm32-wasip1 target
// (`rustup target add wasm32-wasip1`); crates come from crates.io. Run from packages/browser:
//
//   node scripts/build-rust-fixtures.mjs [--out rust-fixtures/out]
//
// <out>/todo_service.wasm  an axum CRUD service on tokio-postgres (bfwc-wasi reactor)
// <out>/hello.wasm         a WASI command
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(packageDir, 'rust-fixtures');
const at = process.argv.indexOf('--out');
const outArg = at >= 0 ? process.argv[at + 1] : 'rust-fixtures/out';
if (!outArg || outArg.startsWith('--')) throw new Error('--out needs a directory: node scripts/build-rust-fixtures.mjs --out <dir>');
const out = resolve(packageDir, outArg);
const TARGET = 'wasm32-wasip1';

// In the fixtures' directory, so rust-toolchain.toml picks (and installs) the pinned toolchain.
const installed = execFileSync('rustup', ['target', 'list', '--installed'], { cwd: fixtures, encoding: 'utf8' });
if (!installed.split(/\r?\n/).includes(TARGET)) throw new Error(`The ${TARGET} target is not installed: run \`rustup target add ${TARGET}\`.`);

const started = Date.now();
execFileSync('cargo', ['build', '--release', '--target', TARGET], { cwd: fixtures, stdio: 'inherit' });
mkdirSync(out, { recursive: true });
for (const name of ['todo_service.wasm', 'hello.wasm']) {
  const built = join(fixtures, 'target', TARGET, 'release', name);
  copyFileSync(built, join(out, name));
  console.log(`${name}: ${(statSync(built).size / 1024).toFixed(1)} KiB`);
}
console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s → ${out}`);
