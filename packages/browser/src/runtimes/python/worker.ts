/**
 * The Python process Worker (bundled to dist/runtimes/python/worker.js, and to
 * dist/python-worker.js for the relay): one Python process per Worker. Pyodide
 * loads when the process starts, from where the host's start message says
 * (default: the pinned jsDelivr build); Python sockets dial through the page
 * (the process protocol's `dial` messages); host extensions are imported here,
 * inside the Worker.
 *
 * Worker globals are typed locally, as in node/worker.ts.
 */
import type { HostToWorker } from '../../node/protocol.js';
import { loadPyodideRuntime } from './pyodideLoader.js';
import { createPythonWorkerProcess } from './pythonWorkerProcess.js';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const process = createPythonWorkerProcess({
  post: (message, transfer) => scope.postMessage(message, transfer),
  loadPyodide: (options) => loadPyodideRuntime(options),
});

scope.addEventListener('message', (event) => process.receive(event.data));
