/**
 * `@seanhogg/builderforce-webcontainers/check` — type-check a project in a Web
 * Worker, with no install and no server.
 *
 * The worker loads the TypeScript compiler from a CDN (pinned below) and fetches
 * dependency types from esm.sh, caching both, so the page's main thread never
 * parses lib.dom.d.ts. Diagnostics come back as plain data (see CheckDiagnostic).
 */
import { VirtualFileSystem, type FlatFiles } from '@seanhogg/builderforce-webcontainers-core';
import type { TypeSources, TypecheckResult } from '@seanhogg/builderforce-webcontainers-core/check';
import { CHECK, CHECK_RESULT, isCheckInput, isCheckReply, type CheckReply } from './protocol.js';

export type { CheckDiagnostic, DiagnosticCategory, TypecheckResult } from '@seanhogg/builderforce-webcontainers-core/check';
export { formatDiagnostic } from '@seanhogg/builderforce-webcontainers-core/check';

/** The TypeScript the checker runs. Pinned, so results do not change under a project. */
export const TYPESCRIPT_VERSION = '5.9.3';
export const DEFAULT_TYPESCRIPT_URL = `https://cdn.jsdelivr.net/npm/typescript@${TYPESCRIPT_VERSION}/lib/typescript.js`;

export interface CheckerOptions {
  /**
   * The worker script (this package's `dist/check/worker.js`). By default it is
   * resolved beside this module, a pattern Vite, webpack 5 and Next.js all bundle.
   */
  workerUrl?: string | URL;
  /** Build the Worker yourself (a CSP that needs a specific origin, a test double). */
  createWorker?: () => Worker;
  /** A classic-script build of TypeScript that sets `self.ts`. Default: jsDelivr, {@link TYPESCRIPT_VERSION}. */
  typescriptUrl?: string;
  /** Where types, libs and tsconfig packages come from. Libs default to the loaded TypeScript's version. */
  sources?: Partial<TypeSources>;
}

export interface CheckResult extends TypecheckResult {
  durationMs: number;
}

export interface Checker {
  /** Type-check the project. Checks queue; each resolves with its own result. */
  check(files: VirtualFileSystem | FlatFiles): Promise<CheckResult>;
  /** Stop the worker; pending checks reject. */
  dispose(): void;
}

/** Only the files that can affect checking, as text: assets never cross to the worker. */
export function checkInputs(files: VirtualFileSystem | FlatFiles): Record<string, string> {
  let fs: VirtualFileSystem;
  if (files instanceof VirtualFileSystem) fs = files;
  else {
    fs = new VirtualFileSystem();
    fs.mount(files);
  }
  const out: Record<string, string> = {};
  for (const path of fs.list()) if (isCheckInput(path)) out[path.slice(1)] = fs.readText(path) ?? '';
  return out;
}

export function createChecker(options: CheckerOptions = {}): Checker {
  const worker = options.createWorker?.() ?? new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url));
  const pending = new Map<number, { resolve(result: CheckResult): void; reject(error: Error): void }>();
  let nextId = 0;

  worker.addEventListener('message', (event: MessageEvent) => {
    if (!isCheckReply(event.data)) return;
    const reply: CheckReply = event.data;
    const waiter = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.type === CHECK_RESULT) waiter?.resolve({ ...reply.result, durationMs: reply.durationMs });
    else waiter?.reject(new Error(reply.message));
  });
  worker.addEventListener('error', (event: ErrorEvent) => {
    const error = new Error(event.message || 'The check worker failed to start.');
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  return {
    check(files) {
      const id = ++nextId;
      return new Promise<CheckResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({
          type: CHECK,
          id,
          files: checkInputs(files),
          typescriptUrl: options.typescriptUrl ?? DEFAULT_TYPESCRIPT_URL,
          sources: options.sources,
        });
      });
    },
    dispose() {
      worker.terminate();
      const error = new Error('The checker was disposed.');
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  };
}
