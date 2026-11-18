/** Shared fakes for tests that drive the process host with in-thread workers. */
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import { createWorkerProcess } from '../src/node/workerProcess.js';
import type { HostToWorker, WorkerKind } from '../src/node/protocol.js';
import type { ProcessKindPolicy } from '../src/node/processKinds.js';

/** A Worker that runs the process in this thread, with structured-clone messaging like the real thing. */
export function fakeWorker(): WorkerLike {
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
  const proc = createWorkerProcess({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  return worker;
}

/** `createWorker` gets the Worker kind (`python` for Python commands); default: an in-thread Node process Worker for every kind. */
export function host(files: Record<string, string> = {}, killGraceMs = 2000, createWorker: (kind: WorkerKind) => WorkerLike = fakeWorker, kinds?: ProcessKindPolicy) {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  const processes = new ProcessHost({ fs, createWorker, kinds, previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', previewUrl: 'https://app.test/__bfwc/p1/', killGraceMs, packageCache: false });
  return { fs, processes };
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

/** A process's output, readable as it arrives: wait for some text (`until`), or for all of it (`done`). */
export function collect(stream: ReadableStream<string>) {
  let text = '';
  const waiters = new Set<{ wanted: string; resolve(): void }>();
  const done = (async () => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return text;
      text += value;
      for (const waiter of [...waiters]) {
        if (!text.includes(waiter.wanted)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  })();
  return {
    done,
    until: (wanted: string) => (text.includes(wanted) ? Promise.resolve() : new Promise<void>((resolve) => waiters.add({ wanted, resolve }))),
  };
}
