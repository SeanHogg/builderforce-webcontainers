/**
 * The Rust process Worker (bundled to dist/runtimes/rust/worker.js, and to
 * dist/rust-worker.js for the relay): one prebuilt wasm32-wasip1 module per
 * Worker, on the WASI host; outbound TCP dials through the page (the process
 * protocol's `dial` messages).
 *
 * Worker globals are typed locally, as in node/worker.ts.
 */
import type { HostToWorker } from '../../node/protocol.js';
import { createRustWorkerProcess } from './rustWorkerProcess.js';

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const process = createRustWorkerProcess({ post: (message) => scope.postMessage(message) });

scope.addEventListener('message', (event) => process.receive(event.data));
