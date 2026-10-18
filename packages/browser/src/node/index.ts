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
  /** npm registry. Default https://registry.npmjs.org (it sends CORS headers). */
  registry?: string;
  /** Cache npm tarballs in Cache Storage. Default true. */
  packageCache?: boolean;
  /** Extra environment for every process. */
  env?: Record<string, string>;
  /** Grace period before a killed process's worker is terminated. Default 2000ms. */
  killGraceMs?: number;
}

export function createProcessHost(args: { fs: VirtualFileSystem; cwd?: string; base: string; origin: string; previewUrl: string; options?: NodeRuntimeOptions }): ProcessHost {
  const { options = {} } = args;
  const createWorker =
    options.createWorker ??
    (() => new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url), { name: 'bfwc-process' }) as unknown as WorkerLike);
  return new ProcessHost({
    fs: args.fs,
    cwd: args.cwd,
    createWorker,
    previewOrigin: args.origin,
    previewBase: args.base,
    previewUrl: args.previewUrl,
    registry: options.registry,
    packageCache: options.packageCache,
    env: options.env,
    killGraceMs: options.killGraceMs,
  });
}
