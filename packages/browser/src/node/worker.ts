/**
 * The process Worker (bundled to dist/node/worker.js): one program per worker,
 * so a busy loop blocks only itself and `kill` can always terminate it.
 *
 * Worker globals are typed locally rather than through `lib.webworker`, which
 * cannot share a compilation with the DOM lib the rest of the package needs.
 */
import { createWorkerProcess } from './workerProcess.js';
import { createCacheStoragePackageCache } from '../packageCache.js';
import type { HostToWorker } from './protocol.js';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker }) => void): void;
  addEventListener(type: 'error', listener: (event: { error: unknown; message: string; preventDefault(): void }) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: { reason: unknown; preventDefault(): void }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const nativeFetch = globalThis.fetch.bind(globalThis);
let cache: ReturnType<typeof createCacheStoragePackageCache> | undefined;
const uncaught = new Set<(error: unknown) => void>();

scope.addEventListener('error', (event) => {
  if (!uncaught.size) return;
  event.preventDefault();
  for (const handler of uncaught) handler(event.error ?? new Error(event.message));
});
scope.addEventListener('unhandledrejection', (event) => {
  if (!uncaught.size) return;
  event.preventDefault();
  for (const handler of uncaught) handler(event.reason);
});

const process = createWorkerProcess({
  post: (message) => scope.postMessage(message),
  fetch: (input, init) => nativeFetch(input, init),
  packageCache: () => (cache ??= createCacheStoragePackageCache()),
  ownsRealm: true,
  trapUncaught(handler) {
    uncaught.add(handler);
    return () => uncaught.delete(handler);
  },
});

scope.addEventListener('message', (event) => process.receive(event.data));
