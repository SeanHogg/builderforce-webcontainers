/**
 * Glue between the preview runtime and the Node process host: options, the
 * default Worker, and answering `/__port/<n>/…` preview requests from the
 * virtual server listening on that port (portResponder.ts).
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from './processHost.js';

export { ProcessHost } from './processHost.js';
export type { ProcessHostOptions, ProcessInfo, WorkerLike } from './processHost.js';
export { createWorkerProcess } from './workerProcess.js';
export { servePortRequest, createPortResponder, openPortResponse, injectBridge } from './portResponder.js';
export type { PortResponder, PortResponderOptions, OpenedPortResponse } from './portResponder.js';

export interface NodeRuntimeOptions {
  /**
   * Where this package's `dist/node/worker.js` is served. Default: resolved
   * beside this module (`new URL('./worker.js', import.meta.url)`), which
   * bundlers that understand `new Worker(new URL(…))` handle automatically.
   */
  workerUrl?: string | URL;
  /** Build each process Worker yourself (CSP, a test double). Wins over `workerUrl`. */
  createWorker?: () => WorkerLike;
  /** Build each database Worker yourself. It must run on the host origin, never the preview origin. Wins over `workerUrl`. */
  createDatabaseWorker?: () => WorkerLike;
  /** npm registry. Default https://registry.npmjs.org (it sends CORS headers). */
  registry?: string;
  /** Cache npm tarballs in Cache Storage. Default true. */
  packageCache?: boolean;
  /** Extra environment for every process. */
  env?: Record<string, string>;
  /** Grace period before a killed process's worker is terminated. Default 2000ms. */
  killGraceMs?: number;
  /** Keep one spare process Worker primed with the file system, so a spawn sends only the changes since. Default true. */
  warmWorker?: boolean;
}

const bundledWorker = (options: NodeRuntimeOptions, name: string) => () =>
  new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url), { name }) as unknown as WorkerLike;

/** How this runtime starts a process Worker: the option (in relay mode, the relay's, on the preview origin), else the bundled script. */
export function workerFactory(options: NodeRuntimeOptions = {}): () => WorkerLike {
  return options.createWorker ?? bundledWorker(options, 'bfwc-process');
}

/**
 * How this runtime starts a database Worker: always on the HOST origin —
 * `createDatabaseWorker`, else the bundled script beside this module (it turns
 * into a database Worker on `database-open`). Never `createWorker`, which in
 * relay mode starts Workers on the preview origin, where the project's own code
 * runs: the database's storage must be out of its reach.
 */
export function databaseWorkerFactory(options: NodeRuntimeOptions = {}): () => WorkerLike {
  return options.createDatabaseWorker ?? bundledWorker(options, 'bfwc-database');
}

/** Workers a factory started, so their owner can stop the ones still running. */
export function trackWorkers(create: () => WorkerLike): { create(): WorkerLike; terminateAll(): void } {
  const running = new Set<WorkerLike>();
  return {
    create() {
      const worker = create();
      running.add(worker);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        running.delete(worker);
        terminate();
      };
      return worker;
    },
    terminateAll() {
      for (const worker of [...running]) worker.terminate();
    },
  };
}

export function createProcessHost(args: { fs: VirtualFileSystem; cwd?: string; base: string; origin: string; previewUrl: string; options?: NodeRuntimeOptions }): ProcessHost {
  const { options = {} } = args;
  return new ProcessHost({
    fs: args.fs,
    cwd: args.cwd,
    createWorker: workerFactory(options),
    previewOrigin: args.origin,
    previewBase: args.base,
    previewUrl: args.previewUrl,
    registry: options.registry,
    packageCache: options.packageCache,
    env: options.env,
    killGraceMs: options.killGraceMs,
    warmWorker: options.warmWorker,
  });
}
