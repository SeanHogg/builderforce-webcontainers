/**
 * Glue between the preview runtime and the Node process host: options, the
 * default Worker, and answering `/__port/<n>/…` preview requests from the
 * virtual server listening on that port.
 */
import { parsePortPath, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { WireRequest, WireResponse } from '../protocol.js';
import { ProcessHost, type WorkerLike } from './processHost.js';

export { ProcessHost } from './processHost.js';
export type { ProcessHostOptions, WorkerLike } from './processHost.js';
export { createWorkerProcess } from './workerProcess.js';

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

export function createProcessHost(args: { fs: VirtualFileSystem; base: string; origin: string; previewUrl: string; options?: NodeRuntimeOptions }): ProcessHost {
  const { options = {} } = args;
  const createWorker =
    options.createWorker ??
    (() => new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url), { name: 'bfwc-process' }) as unknown as WorkerLike);
  return new ProcessHost({
    fs: args.fs,
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

const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

/** Answer a preview request addressed to a virtual server. */
export async function servePortRequest(host: ProcessHost, request: WireRequest): Promise<{ message: WireResponse; transfer: Transferable[] }> {
  const target = parsePortPath(request.path)!;
  const response = await host.request(target.port, {
    method: request.method ?? 'GET',
    url: target.path + request.search,
    headers: request.headers ?? {},
    body: request.body ? new Uint8Array(request.body) : null,
  });
  if (!response) {
    return { message: { type: 'response', reqId: request.reqId, status: 502, headers: TEXT, body: `Nothing is listening on port ${target.port}. Start a server (node server.js) first.` }, transfer: [] };
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  const body = response.body.slice().buffer as ArrayBuffer;
  return { message: { type: 'response', reqId: request.reqId, status: response.status, headers, body }, transfer: [body] };
}
