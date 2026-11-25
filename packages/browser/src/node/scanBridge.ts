/**
 * The process Worker's end of the code-scanner port. A Worker cannot hold the embedder's scanner (a
 * function does not cross `postMessage`), so `npm install` inside it asks the PAGE: a `scan` message
 * out, a `scan-result` back. The page's scanner and its report to the Shield stay out of the Worker's
 * reach; a Worker that never asks is still covered by the page's write rescan (`writeScan.ts`).
 */
import type { CodeScanner, CodeScanVerdict } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';

export function createScanBridge(post: (message: WorkerToHost) => void): { scanner: CodeScanner; receive(message: HostToWorker): boolean } {
  let nextId = 1;
  const pending = new Map<number, (verdicts: readonly CodeScanVerdict[]) => void>();
  return {
    scanner: {
      scan(origin, subjects, signal) {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
          const scanId = nextId++;
          pending.set(scanId, resolve);
          signal?.addEventListener('abort', () => (pending.delete(scanId), reject(signal.reason)), { once: true });
          post({ type: 'scan', scanId, origin, subjects: [...subjects] });
        });
      },
    },
    receive(message) {
      if (message.type !== 'scan-result') return false;
      pending.get(message.scanId)?.(message.verdicts);
      pending.delete(message.scanId);
      return true;
    },
  };
}
