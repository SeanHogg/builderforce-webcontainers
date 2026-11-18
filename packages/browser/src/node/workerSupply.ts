/**
 * Where a new process's Worker comes from, with the file system it starts on.
 *
 * Cold: a new Worker and the cached snapshot (pack + ops since it). Warm: after
 * a spawn, one spare Worker is created off the spawn's critical path and primed
 * with the snapshot — it loads its script and mounts the file system while
 * nothing waits on it, then acknowledges (`primed`) — so the next spawn takes it
 * and sends only the journal ops since it was primed. A spare is taken only once
 * it has acknowledged: one still loading stays the spare and that spawn goes
 * cold; one that failed, or fell further behind than the journal holds, is
 * dropped.
 */
import type { VfsDelta, VfsSnapshot, VfsSnapshots } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerLike } from './processHost.js';
import type { HostToWorker, WorkerToHost } from './protocol.js';

interface Spare {
  worker: WorkerLike;
  /** The journal sequence its file system is current at. */
  seq: number;
  primed: boolean;
  failed: boolean;
}

export class WorkerSupply {
  private spare?: Spare;
  private refill?: ReturnType<typeof setTimeout>;
  private disposed = false;
  /** Spawns that took a primed spare (tests and benchmarks read this). */
  warmStarts = 0;
  /** Spares created so far. */
  primes = 0;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly snapshots: VfsSnapshots,
    /** Keep a primed spare. When false every spawn is cold. */
    private readonly warm: boolean,
  ) {}

  /** A Worker for a new process, and what its `start` message carries for the file system. */
  take(): { worker: WorkerLike; snapshot: VfsSnapshot | VfsDelta } {
    if (this.disposed) throw new Error('The process host was disposed.');
    const taken = this.fromSpare() ?? this.cold();
    if (this.warm) this.scheduleRefill();
    return taken;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refill);
    this.refill = undefined;
    this.spare?.worker.terminate();
    this.spare = undefined;
  }

  /** The spare and the ops since its prime, if it acknowledged and is not too far behind; drops a spare that never will be usable. */
  private fromSpare(): { worker: WorkerLike; snapshot: VfsDelta } | undefined {
    const spare = this.spare;
    if (!spare || (!spare.primed && !spare.failed)) return undefined; // none, or still loading: keep it for a later spawn
    this.spare = undefined;
    const ops = spare.failed ? undefined : this.snapshots.delta(spare.seq);
    if (!ops) {
      spare.worker.terminate();
      return undefined;
    }
    spare.worker.onmessage = null;
    spare.worker.onerror = null;
    this.warmStarts++;
    return { worker: spare.worker, snapshot: { ops } };
  }

  private cold(): { worker: WorkerLike; snapshot: VfsSnapshot } {
    return { worker: this.createWorker(), snapshot: this.snapshots.snapshot() };
  }

  /** Prime a spare once the current task (the spawn) is done, so it never adds to a spawn's latency. */
  private scheduleRefill(): void {
    if (this.refill !== undefined || this.spare) return;
    this.refill = setTimeout(() => {
      this.refill = undefined;
      if (this.disposed || this.spare) return;
      const worker = this.createWorker();
      const snapshot = this.snapshots.snapshot();
      const spare: Spare = { worker, seq: snapshot.seq, primed: false, failed: false };
      worker.onmessage = (event) => {
        if ((event.data as WorkerToHost)?.type === 'primed') spare.primed = true;
      };
      worker.onerror = () => {
        spare.failed = true;
      };
      worker.postMessage({ type: 'prime', snapshot } satisfies HostToWorker);
      this.spare = spare;
      this.primes++;
    }, 0);
  }
}
