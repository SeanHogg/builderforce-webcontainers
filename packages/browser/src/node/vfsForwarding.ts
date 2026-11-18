/**
 * A worker's file system as a mirror of the page's: its own changes are
 * posted to the page as ops, batched per microtask (`flush` sends them now),
 * and the page's ops — or a mounted snapshot — are applied `quietly`, without
 * echoing back. Directories made explicit are forwarded too (`promotions`), so
 * they outlive their last file on the page as well. Shared by the Node process
 * Worker (workerProcess.ts) and the Rust one (runtimes/rust/rustWorkerProcess.ts).
 */
import { applyOps, changeToOp, type VfsOp, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';

export interface ForwardedVfs {
  /** Post the changes not yet sent (before a child spawns, before an exit). */
  flush(): void;
  /** Run `load` (applying the page's ops, mounting a snapshot) without forwarding what it changes. */
  quietly(load: () => void): void;
  /** Apply the page's ops without echoing them back. */
  apply(ops: readonly VfsOp[]): void;
}

export function forwardVfsChanges(fs: VirtualFileSystem, send: (ops: VfsOp[]) => void): ForwardedVfs {
  let applying = false;
  let pending: VfsOp[] = [];
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    if (!pending.length) return;
    const ops = pending;
    pending = [];
    send(ops);
  };

  fs.watch(
    (change) => {
      if (applying) return;
      pending.push(changeToOp(fs, change));
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
    { promotions: true },
  );

  const quietly = (load: () => void) => {
    applying = true;
    try {
      load();
    } finally {
      applying = false;
    }
  };

  return { flush, quietly, apply: (ops) => quietly(() => applyOps(fs, ops)) };
}
