/** Shared fakes for tests that drive the process host with in-thread workers. */
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from '../src/node/processHost.js';
import { createWorkerProcess } from '../src/node/workerProcess.js';
import type { HostToWorker } from '../src/node/protocol.js';

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

export function host(files: Record<string, string> = {}, killGraceMs = 2000) {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  const processes = new ProcessHost({ fs, createWorker: fakeWorker, previewOrigin: 'https://app.test', previewBase: '/__bfwc/p1/', previewUrl: 'https://app.test/__bfwc/p1/', killGraceMs, packageCache: false });
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
