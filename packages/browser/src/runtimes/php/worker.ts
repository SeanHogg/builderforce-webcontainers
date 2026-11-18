/**
 * The PHP process Worker (to be bundled to dist/runtimes/php/worker.js, and to
 * dist/php-worker.js for the relay): one PHP process per Worker. php-wasm
 * loads when the process starts, from where the host's start message says
 * (default: the pinned jsDelivr build); PHP's sockets dial through the page
 * (the process protocol's `dial` messages).
 *
 * Worker globals are typed locally, as in node/worker.ts.
 */
import type { HostToWorker } from '../../node/protocol.js';
import { loadPhpRuntime } from './phpLoader.js';
import { createPhpWorkerProcess } from './phpWorkerProcess.js';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const process = createPhpWorkerProcess({
  post: (message) => scope.postMessage(message),
  loadPhp: (options) => loadPhpRuntime(options),
});

scope.addEventListener('message', (event) => process.receive(event.data));
