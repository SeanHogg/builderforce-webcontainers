/**
 * Where a new process's Worker comes from, with the file system it starts on.
 *
 * Cold: a new Worker and the cached snapshot (pack + ops since it). Warm: after
 * a spawn, one spare Worker is created off the spawn's critical path and primed
 * with the snapshot — it loads its script and mounts the file system while
 * nothing waits on it — so the next spawn takes it and sends only the journal
 * ops since it was primed. A spare that fell too far behind (or failed) is
 * dropped and the spawn goes cold.
 */
import type { VfsDelta, VfsSnapshot, VfsSnapshots } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerLike } from './processHost.js';
import type { HostToWorker } from './protocol.js';

interface Spare {
  worker: WorkerLike;
  /** The journal sequence its file system is current at. */
  seq: number;
  failed: boolean;
}

export class WorkerSupply {
  private spare?: Spare;
  private refill?: ReturnType<typeof setTimeout>;
  private disposed = false;
  /** Spawns that took a primed spare (tests and benchmarks read this). */
  warmStarts = 0;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly snapshots: VfsSnapshots,
    /** Keep a primed spare. When false every spawn is cold. */
    private readonly warm: boolean,
  ) {}

  /** A Worker for a new process, and what its `start` message carries for the file system. */
  take(): { worker: WorkerLike; snapshot: VfsSnapshot | VfsDelta } {
    const spare = this.spare;
    this.spare = undefined;
    const ops = spare && !spare.failed ? this.snapshots.delta(spare.seq) : undefined;
    if (this.warm) this.scheduleRefill();
    if (spare && ops) {
      spare.worker.onerror = null;
      this.warmStarts++;
      return { worker: spare.worker, snapshot: { ops } };
    }
    spare?.worker.terminate();
    return { worker: this.createWorker(), snapshot: this.snapshots.snapshot() };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refill);
    this.spare?.worker.terminate();
    this.spare = undefined;
  }

  /** Prime a spare once the current task (the spawn) is done, so it never adds to a spawn's latency. */
  private scheduleRefill(): void {
    if (this.refill !== undefined) return;
    this.refill = setTimeout(() => {
      this.refill = undefined;
      if (this.disposed || this.spare) return;
      const worker = this.createWorker();
      const spare: Spare = { worker, seq: this.snapshots.seq, failed: false };
      worker.onerror = () => {
        spare.failed = true;
      };
      worker.postMessage({ type: 'prime', snapshot: this.snapshots.snapshot() } satisfies HostToWorker);
      this.spare = spare;
    }, 0);
  }
}
