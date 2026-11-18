/**
 * PHP processes driven in-thread: the real worker code (createPhpWorkerProcess)
 * on a real php-wasm from the pinned `@php-wasm/node` package, behind a real
 * ProcessHost that also runs Node processes — only the Worker boundary is faked.
 * php-wasm's Node build sets up its own outbound WebSocket proxy; the runtime
 * repoints the socket layer at the virtual network (installPhpSockets), as in
 * the browser.
 */
import { loadNodeRuntime } from '@php-wasm/node';
import { PHP, __private__dont__use } from '@php-wasm/universal';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import { PHP_KIND, createPhpProcessKind, createPhpWorkerProcess, type LoadedPhp, type PhpHostOptions, type PhpLike, type PhpModuleLike } from '../src/runtimes/php/index.js';
import { fakeWorker } from './helpers.js';

export { readAll } from './helpers.js';

/** A process's output as it arrives: all of it so far (`text`), or a wait for some (`until`). */
export function collect(stream: ReadableStream<string>): { text(): string; until(wanted: string, timeoutMs?: number): Promise<void> } {
  let text = '';
  void (async () => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += value;
    }
  })();
  return { text: () => text, until: (wanted, timeoutMs = 60_000) => until(() => text.includes(wanted), timeoutMs).catch(() => Promise.reject(new Error(`Timed out waiting for "${wanted}" in:\n${text}`))) };
}

/** The test realm's own `process`, before any in-thread Node process ran in it. */
const hostProcess = globalThis.process;
let nextProcessId = 100;

/** A fresh PHP. In a real Worker each process has its realm to itself; here an in-thread Node process may have left its `process` on the shared global. */
export async function loadTestPhp(phpVersion = '8.3'): Promise<LoadedPhp> {
  const current = globalThis.process;
  globalThis.process = hostProcess;
  try {
    const runtime = await loadNodeRuntime(phpVersion as '8.3', { emscriptenOptions: { processId: nextProcessId++ } });
    const php = new PHP(runtime);
    return { php: php as unknown as PhpLike, module: (php as unknown as Record<symbol, PhpModuleLike>)[__private__dont__use]! };
  } finally {
    globalThis.process = current;
  }
}

/** A PHP process Worker running in this thread, with structured-clone messaging like the real thing. */
export function fakePhpWorker(options: { fetch?: typeof fetch } = {}): WorkerLike {
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
  const proc = createPhpWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    loadPhp: ({ phpVersion }) => loadTestPhp(phpVersion),
    fetch: options.fetch,
  });
  return worker;
}

/** In-thread Workers of each kind: PHP processes on a real php-wasm, the rest on the Node runtime. */
export const phpWorkers = (options: Parameters<typeof fakePhpWorker>[0] = {}) => (kind: WorkerKind) => (kind === PHP_KIND ? fakePhpWorker(options) : fakeWorker());

/** A process host whose PHP commands run in PHP Workers (`processes` is the host; `ports` its port table). */
export function phpHost(files: Record<string, string> = {}, env: Record<string, string> = {}, options: { php?: PhpHostOptions; fetch?: typeof fetch } = {}) {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  const processes = new ProcessHost({
    fs,
    env,
    createWorker: phpWorkers({ fetch: options.fetch }),
    previewOrigin: 'https://app.test',
    previewBase: '/__bfwc/p1/',
    killGraceMs: 500,
    packageCache: false,
    kinds: createPhpProcessKind(options.php),
  });
  return { fs, ports: processes.ports, processes };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function request(ports: ProcessHost['ports'], port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const response = await ports.requestBuffered(port, { method, url, headers, body: body === undefined ? null : encoder.encode(body) });
  if (!response) throw new Error(`Nothing listens on ${port}`);
  return { status: response.status, headers: response.headers, text: decoder.decode(response.body) };
}

/** A response body as JSON; anything else (a PHP warning page) fails with the body itself. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Not JSON:\n${text}`);
  }
}

/** Wait until `condition` holds (each check after the pending messages are delivered). */
export async function until(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
