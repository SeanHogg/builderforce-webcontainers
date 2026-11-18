/**
 * Rust processes driven in-thread: the real worker code
 * (createRustWorkerProcess) behind a real ProcessHost that also runs Node
 * processes — only the Worker boundary is faked. The prebuilt fixtures come
 * from scripts/build-rust-fixtures.mjs (`RUST_FIXTURES_DIR`, when built).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import { RUST_KIND, createRustProcessKind } from '../src/runtimes/rust/index.js';
import { createRustWorkerProcess } from '../src/runtimes/rust/rustWorkerProcess.js';
import { fakeWorker } from './helpers.js';

/** The built fixtures: `BFWC_RUST_FIXTURES`, else rust-fixtures/out — undefined until built. */
const configured = process.env.BFWC_RUST_FIXTURES ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rust-fixtures', 'out');
const built = existsSync(join(configured, 'todo_service.wasm')) && existsSync(join(configured, 'hello.wasm'));
// Named explicitly (CI): missing fixtures are a failure, never a skip.
if (process.env.BFWC_RUST_FIXTURES && !built) throw new Error(`BFWC_RUST_FIXTURES=${configured} has no todo_service.wasm and hello.wasm: build them with scripts/build-rust-fixtures.mjs.`);
export const RUST_FIXTURES_DIR = built ? configured : undefined;

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(RUST_FIXTURES_DIR!, name)));

/** A Rust process Worker running in this thread, with structured-clone messaging like the real thing. */
export function fakeRustWorker(): WorkerLike {
  let alive = true;
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const copy = structuredClone(message) as HostToWorker;
      queueMicrotask(() => alive && proc.receive(copy));
    },
    terminate() {
      alive = false;
    },
  };
  const proc = createRustWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
  });
  return worker;
}

/** In-thread Workers of each kind: Rust processes in Rust Workers, the rest on the Node runtime. */
export const rustWorkers = (kind: WorkerKind) => (kind === RUST_KIND ? fakeRustWorker() : fakeWorker());

/** A process host whose Rust commands run in Rust Workers. */
export function rustHost(files: Record<string, string | Uint8Array> = {}, env: Record<string, string> = {}) {
  const fs = new VirtualFileSystem();
  for (const [path, contents] of Object.entries(files)) fs.writeFile(`/${path}`, contents);
  const processes = new ProcessHost({
    fs,
    env,
    createWorker: rustWorkers,
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    killGraceMs: 500,
    packageCache: false,
    kinds: createRustProcessKind(),
  });
  return { fs, ports: processes.ports, processes };
}
