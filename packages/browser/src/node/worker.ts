/**
 * The process Worker (bundled to dist/node/worker.js): one program per worker,
 * so a busy loop blocks only itself and `kill` can always terminate it. A
 * Worker whose first message is `database-open` becomes a database Worker
 * instead (PGlite and the Postgres gateway, database/databaseWorker.ts). The
 * runtime starts database Workers from this script on the HOST origin only
 * (`databaseWorkerFactory`), never through the relay, so a database's storage
 * stays out of reach of the code a project runs.
 *
 * Worker globals are typed locally rather than through `lib.webworker`, which
 * cannot share a compilation with the DOM lib the rest of the package needs.
 */
import { createWorkerProcess } from './workerProcess.js';
import { createCacheStoragePackageCache } from '../packageCache.js';
import type { HostToWorker } from './protocol.js';
import { createDatabaseWorker } from '../database/databaseWorker.js';
import { isDatabaseOpen, type ToDatabase } from '../database/databaseProtocol.js';
import { deletePgliteStorage, pgliteFrom } from '../database/pgliteLoader.js';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: HostToWorker | ToDatabase }) => void): void;
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

/** What this Worker runs: a process, or — told so by its first message — a database. */
let receive: ((message: never) => void) | undefined;

const startProcess = () =>
  createWorkerProcess({
    post: (message) => scope.postMessage(message),
    fetch: (input, init) => nativeFetch(input, init),
    packageCache: () => (cache ??= createCacheStoragePackageCache()),
    ownsRealm: true,
    trapUncaught(handler) {
      uncaught.add(handler);
      return () => uncaught.delete(handler);
    },
  });

const startDatabase = () =>
  createDatabaseWorker({
    post: (message) => scope.postMessage(message),
    openPGlite: (url) => pgliteFrom(url),
    deleteStorage: (dataDir) => deletePgliteStorage(dataDir),
  });

scope.addEventListener('message', (event) => {
  receive ??= (isDatabaseOpen(event.data) ? startDatabase() : startProcess()).receive as (message: never) => void;
  receive(event.data as never);
});
