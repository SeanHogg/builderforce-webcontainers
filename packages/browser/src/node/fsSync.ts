/**
 * Keeping every process's file system in step with the page's, which is the
 * authoritative one. The page's changes are batched per process (one `fs`
 * message per process per microtask), and a process's changes are applied to the
 * page's file system, from which every other process gets them. A process never
 * gets its own changes back. Promotions (an existing directory made explicit by
 * `mkdir`) travel too, so a mirror keeps the directories that outlive their files.
 *
 * It also holds the snapshots new processes start from (core vfs/snapshots.ts):
 * the same file system, the same op stream.
 */
import { VfsSnapshots, applyOps, changeToOp, type FsChange, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { FsOp } from './protocol.js';

export class FsSync<Peer> {
  /** What each new process starts from: one pack reused until the project outgrows it, plus the ops since. */
  readonly snapshots: VfsSnapshots;
  /** Each running process, with the page's changes it has not been sent yet. */
  private readonly outboxes = new Map<Peer, FsOp[]>();
  private applyingFrom?: Peer;
  private flushScheduled = false;
  private readonly unwatch: () => void;

  constructor(private readonly fs: VirtualFileSystem, private readonly send: (peer: Peer, ops: FsOp[]) => void) {
    this.snapshots = new VfsSnapshots(fs);
    this.unwatch = fs.watch((change) => this.onChange(change), { promotions: true });
  }

  /** Start sending changes to `peer` (a process just started from a snapshot taken now). */
  add(peer: Peer): void {
    this.outboxes.set(peer, []);
  }

  remove(peer: Peer): void {
    this.outboxes.delete(peer);
  }

  /** Send every pending batch now (before a spawn or an exit, so nothing is seen out of order). */
  flush(): void {
    this.flushScheduled = false;
    for (const [peer, ops] of this.outboxes) {
      if (!ops.length) continue;
      this.outboxes.set(peer, []);
      this.send(peer, ops);
    }
  }

  /** Apply a process's changes to the page's file system; every other process gets them. */
  applyFrom(peer: Peer, ops: readonly FsOp[]): void {
    this.applyingFrom = peer;
    try {
      applyOps(this.fs, ops);
    } finally {
      this.applyingFrom = undefined;
    }
  }

  dispose(): void {
    this.unwatch();
    this.outboxes.clear();
    this.snapshots.dispose();
  }

  private onChange(change: FsChange): void {
    const op = changeToOp(this.fs, change);
    for (const [peer, ops] of this.outboxes) if (peer !== this.applyingFrom) ops.push(op);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }
}
