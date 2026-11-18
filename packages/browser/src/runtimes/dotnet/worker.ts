/**
 * The .NET process Worker (bundled to dist/runtimes/dotnet/worker.js, and to
 * dist/dotnet-worker.js for the relay): one .NET process per Worker —
 * Mono's runtime is a singleton of its realm. The runtime bundle loads when
 * the process needs it, from the URL the host's start message gives; outbound
 * TCP dials through the page (the process protocol's `dial` messages).
 *
 * Worker globals are typed locally, as in node/worker.ts.
 */
import type { HostToWorker } from '../../node/protocol.js';
import { loadDotnetRuntime } from './dotnetLoader.js';
import { createDotnetWorkerProcess } from './dotnetWorkerProcess.js';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const process = createDotnetWorkerProcess({
  post: (message) => scope.postMessage(message),
  loadDotnet: (options) => loadDotnetRuntime(options),
});

scope.addEventListener('message', (event) => process.receive(event.data));
