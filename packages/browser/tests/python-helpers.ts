/**
 * Python processes driven in-thread: the real worker code (createPythonWorkerProcess)
 * on a real Pyodide from the pinned `pyodide` npm package, behind a real
 * ProcessHost that also runs Node processes — only the Worker boundary is faked.
 */
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { loadPyodide } from 'pyodide';
import { VirtualFileSystem, type PortRegistry } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import { createPythonProcessKind, createPythonWorkerProcess, type ImportModule, type PyodideLike, type PythonHostOptions, type VirtualTcpTransport } from '../src/runtimes/python/index.js';
import { fakeWorker } from './helpers.js';
import { VENDORED_PYODIDE_PACKAGES } from './python-index.js';

/**
 * Pyodide's package cache for this test run, outside the repository: seeded
 * with the vendored lock-file packages (micropip, python-dateutil, six), so
 * the offline tests load nothing from the CDN — a file appearing here beyond
 * the seed is a download (`downloadedPackages()`).
 */
export const PACKAGE_CACHE = mkdtempSync(join(tmpdir(), 'bfwc-pyodide-test-cache-'));
const SEEDED = readdirSync(VENDORED_PYODIDE_PACKAGES);
for (const file of SEEDED) copyFileSync(join(VENDORED_PYODIDE_PACKAGES, file), join(PACKAGE_CACHE, file));

/** Package files Pyodide fetched from its CDN during this run (none, for an offline test). */
export const downloadedPackages = () => readdirSync(PACKAGE_CACHE).filter((file) => !SEEDED.includes(file));

/** The installed package's directory: Pyodide's own detection reads vitest's transformed stack and guesses wrong. */
const INDEX_URL = `${dirname(createRequire(import.meta.url).resolve('pyodide'))}${sep}`;

/** The test realm's own `process`, before any in-thread Node process ran in it. */
const hostProcess = globalThis.process;

/**
 * A fresh interpreter. In a real Worker each process has its realm to itself;
 * here an in-thread Node process may have left its `process` on the shared
 * global, which Pyodide's Node start-up reads — so it starts with the host's.
 */
export async function loadTestPyodide(env: Record<string, string> = {}): Promise<PyodideLike> {
  const current = globalThis.process;
  globalThis.process = hostProcess;
  try {
    return (await loadPyodide({ indexURL: INDEX_URL, packageCacheDir: PACKAGE_CACHE, env, stdout: () => undefined, stderr: () => undefined })) as unknown as PyodideLike;
  } finally {
    globalThis.process = current;
  }
}

/** A Python process Worker running in this thread, with structured-clone messaging like the real thing. */
export function fakePythonWorker(options: { tcp?: VirtualTcpTransport; importModule?: ImportModule } = {}): WorkerLike {
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
  const proc = createPythonWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    loadPyodide: ({ env }) => loadTestPyodide(env),
    ...options,
  });
  return worker;
}

/** In-thread Workers of each kind: Python processes on a real Pyodide, the rest on the Node runtime. */
export const mixedWorkers = (options: Parameters<typeof fakePythonWorker>[0] = {}) => (kind: WorkerKind) => (kind === 'python' ? fakePythonWorker(options) : fakeWorker());

/** A process host whose Python commands run in Python Workers (`python` is the host; `ports` its port table; `kinds` the Python policy, with the pip record). */
export function pythonHost(files: Record<string, string> = {}, env: Record<string, string> = {}, options: { python?: PythonHostOptions; importModule?: ImportModule } = {}) {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  const kinds = createPythonProcessKind(options.python);
  const python = new ProcessHost({
    fs,
    env,
    createWorker: mixedWorkers({ importModule: options.importModule }),
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    killGraceMs: 500,
    packageCache: false,
    kinds,
  });
  return { fs, ports: python.ports, python, kinds };
}

export async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/** Everything the stream says, readable so far at any time (a server's log while it keeps running). */
export function collect(stream: ReadableStream<string>): { text(): string } {
  let text = '';
  void (async () => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += value;
    }
  })();
  return { text: () => text };
}

/** Resolves once `port` is open in `ports`. */
export function portOpened(ports: PortRegistry, port: number): Promise<void> {
  if (ports.has(port)) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = ports.watch((event) => {
      if (event.type === 'open' && event.port === port) {
        stop();
        resolve();
      }
    });
  });
}

/** `port` opens — or the process exits first, which fails with its log. */
export async function serving(ports: PortRegistry, port: number, proc: { wait(): Promise<number> }, log: { text(): string }): Promise<void> {
  await Promise.race([portOpened(ports, port), proc.wait().then((code) => Promise.reject(new Error(`exited ${code} before serving: ${log.text()}`)))]);
}

/** Wait until `condition` holds (each check after the pending messages are delivered). */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function request(ports: PortRegistry, port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const response = await ports.requestBuffered(port, { method, url, headers, body: body === undefined ? null : encoder.encode(body) });
  if (!response) throw new Error(`Nothing listens on ${port}`);
  return { status: response.status, headers: response.headers, text: decoder.decode(response.body) };
}

/** Whether the Pyodide CDN (packages) and PyPI (pure wheels) are reachable — asked by the networked tests themselves, never at import. */
export async function online(): Promise<boolean> {
  const reachable = (url: string) =>
    fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(
      (response) => response.ok,
      () => false,
    );
  const [cdn, pypi] = await Promise.all([reachable('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide-lock.json'), reachable('https://pypi.org/simple/flask/')]);
  return cdn && pypi;
}
