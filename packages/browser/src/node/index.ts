/**
 * Glue between the preview runtime and the Node process host: options, the
 * default Worker, and answering `/__port/<n>/…` preview requests from the
 * virtual server listening on that port (portResponder.ts).
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { ProcessHost, type WorkerLike } from './processHost.js';
import type { ProcessKindPolicy } from './processKinds.js';
import type { ProcessShieldOptions } from './processIdentity.js';
import type { WorkerKind } from './protocol.js';

export { ProcessHost } from './processHost.js';
export type { ProcessHostOptions, ProcessInfo, WorkerLike } from './processHost.js';
export type { ProcessKindPolicy, ProcessRoute } from './processKinds.js';
export type { PythonExtensionRef, WorkerKind } from './protocol.js';
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
  /** Where this package's `dist/runtimes/python/worker.js` (the Python process Worker) is served. Default: resolved beside this module. */
  pythonWorkerUrl?: string | URL;
  /** Where this package's `dist/runtimes/php/worker.js` (the PHP process Worker) is served. Default: resolved beside this module. */
  phpWorkerUrl?: string | URL;
  /** Where this package's `dist/runtimes/dotnet/worker.js` (the .NET process Worker) is served. Default: resolved beside this module. */
  dotnetWorkerUrl?: string | URL;
  /** Where this package's `dist/runtimes/rust/worker.js` (the Rust process Worker) is served. Default: resolved beside this module. */
  rustWorkerUrl?: string | URL;
  /**
   * Build each process Worker yourself (CSP, a test double, the relay's
   * `PreviewTransport.createWorker`). It is told the Worker kind the command
   * needs: `python` for Python commands, `php` for PHP ones, `dotnet` for .NET
   * ones, else `node`. Wins over the URLs.
   */
  createWorker?: (kind: WorkerKind) => WorkerLike;
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

/**
 * Each interpreter runtime's bundled process Worker. Every `new URL(…)` is
 * spelled out literally so bundlers that understand `new Worker(new URL(…))`
 * pick each script up.
 */
const BUNDLED_RUNTIME_WORKERS: Readonly<Record<Exclude<WorkerKind, 'node'>, (options: NodeRuntimeOptions) => WorkerLike>> = {
  python: (options) => new Worker(options.pythonWorkerUrl ?? new URL('../runtimes/python/worker.js', import.meta.url), { name: 'bfwc-python' }) as unknown as WorkerLike,
  php: (options) => new Worker(options.phpWorkerUrl ?? new URL('../runtimes/php/worker.js', import.meta.url), { name: 'bfwc-php' }) as unknown as WorkerLike,
  dotnet: (options) => new Worker(options.dotnetWorkerUrl ?? new URL('../runtimes/dotnet/worker.js', import.meta.url), { name: 'bfwc-dotnet' }) as unknown as WorkerLike,
  rust: (options) => new Worker(options.rustWorkerUrl ?? new URL('../runtimes/rust/worker.js', import.meta.url), { name: 'bfwc-rust' }) as unknown as WorkerLike,
};

/** How this runtime starts a process Worker of a kind: the option (in relay mode, the relay's, on the preview origin), else the bundled script. */
export function workerFactory(options: NodeRuntimeOptions = {}): (kind: WorkerKind) => WorkerLike {
  if (options.createWorker) return options.createWorker;
  const node = bundledWorker(options, 'bfwc-process');
  return (kind) => (kind === 'node' ? node() : BUNDLED_RUNTIME_WORKERS[kind](options));
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

export function createProcessHost(args: { fs: VirtualFileSystem; cwd?: string; base: string; origin: string; previewUrl: string; options?: NodeRuntimeOptions; kinds?: ProcessKindPolicy; security?: ProcessShieldOptions }): ProcessHost {
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
    kinds: args.kinds,
    security: args.security,
  });
}
