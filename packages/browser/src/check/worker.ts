/**
 * The check worker (bundled to dist/check/worker.js as one classic script). It
 * loads the TypeScript compiler with `importScripts` — TypeScript's own UMD
 * build, which sets `self.ts` — and keeps one TypeStore for its lifetime, so
 * every check after the first reuses fetched and parsed declarations.
 *
 * Worker globals are typed locally, as in sw.ts: `lib.webworker` cannot share a
 * compilation with the DOM lib the rest of the package needs.
 */
import type * as TS from 'typescript';
import { TypeStore, typecheckProject } from '@seanhogg/builderforce-webcontainers-core/check';
import { createCachedFetch } from './cachedFetch.js';
import { CHECK, CHECK_ERROR, CHECK_RESULT, type CheckReply, type CheckRequest } from './protocol.js';

interface WorkerGlobalLike {
  ts?: typeof TS;
  importScripts(url: string): void;
  postMessage(message: CheckReply): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const worker = globalThis as unknown as WorkerGlobalLike;
const store = new TypeStore();
const fetchTypes = createCachedFetch();
let loadedFrom: string | undefined;

function typescript(url: string): typeof TS {
  if (!worker.ts || loadedFrom !== url) {
    worker.importScripts(url);
    loadedFrom = url;
  }
  if (!worker.ts) throw new Error(`${url} did not define the TypeScript compiler.`);
  return worker.ts;
}

worker.addEventListener('message', (event) => {
  const request = event.data as CheckRequest | null;
  if (request?.type !== CHECK) return;
  const started = Date.now();
  void (async () => {
    try {
      const ts = typescript(request.typescriptUrl);
      const result = await typecheckProject(ts, request.files, { fetch: fetchTypes, store, sources: request.sources });
      worker.postMessage({ type: CHECK_RESULT, id: request.id, result, durationMs: Date.now() - started });
    } catch (error) {
      worker.postMessage({ type: CHECK_ERROR, id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
