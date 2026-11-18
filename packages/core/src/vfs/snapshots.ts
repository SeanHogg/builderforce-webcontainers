/**
 * Snapshots for new processes, cheap to hand over and reused across spawns.
 *
 * A snapshot is the cached pack (one ArrayBuffer, see pack.ts) taken at some
 * journal sequence plus the journal ops since then. The journal starts with the
 * first snapshot (nothing is pinned before anyone asks for one) and is bounded
 * by what a snapshot may carry: more than `maxDeltaOps` ops, or more content
 * than max(1 MB, `maxDeltaRatio` of the pack), and it drops them — the next
 * snapshot rebuilds the pack instead. So spawning N processes without an edit
 * in between builds one pack, and an edit costs one small op, not a new copy of
 * the project.
 *
 * A process mounts a snapshot into its own file system: the pack's index is
 * seeded (contents read on first open), then the ops replayed in order — the
 * same replay that keeps a running process in sync. A process host may mount a
 * snapshot into a Worker ahead of time (a warm worker) and later start it with
 * only the `delta` since then.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { VfsJournal, applyOps, type VfsOp } from './journal.js';
import { packFileSystem, readPack } from './pack.js';

/** What a new process starts from: the pack and the changes made after it. */
export interface VfsSnapshot {
  pack: ArrayBuffer;
  ops: VfsOp[];
  /** The journal sequence a mirror is current at once it mounted this. */
  seq: number;
}

/** What a process that already mounted a snapshot (a warm worker) starts from: only the ops since. */
export interface VfsDelta {
  pack?: undefined;
  ops: VfsOp[];
}

export interface SnapshotOptions {
  /** Rebuild the pack once more ops than this accumulated after it. Default 1024. */
  maxDeltaOps?: number;
  /** ...or once their contents exceed this share of the pack's size (never below 1 MB). Default 0.25. */
  maxDeltaRatio?: number;
}

const MIN_DELTA_BYTES = 1024 * 1024;

export class VfsSnapshots {
  private journal?: VfsJournal;
  private current?: { buffer: ArrayBuffer; seq: number };
  private readonly maxDeltaOps: number;
  private readonly maxDeltaRatio: number;
  private disposed = false;
  /** Packs built so far: one per change of the project that outgrew the journal, not one per spawn. */
  builds = 0;

  constructor(private readonly fs: VirtualFileSystem, options: SnapshotOptions = {}) {
    this.maxDeltaOps = options.maxDeltaOps ?? 1024;
    this.maxDeltaRatio = options.maxDeltaRatio ?? 0.25;
  }

  /** Content held by the journal (string length for text): what snapshots pin beyond the pack. */
  get journalBytes(): number {
    return this.journal?.bytesSince(this.current?.seq ?? 0) ?? 0;
  }

  /**
   * The ops that bring a mirror current at sequence `seq` up to now — for a
   * process that already mounted a snapshot (a warm worker). Undefined when the
   * journal no longer holds them: start from a snapshot.
   */
  delta(seq: number): VfsOp[] | undefined {
    this.live();
    return this.journal?.since(seq);
  }

  /** The file system as it is now, as a cached pack plus the ops since it. */
  snapshot(): VfsSnapshot {
    this.live();
    const journal = (this.journal ??= new VfsJournal(this.fs, { maxOps: this.maxDeltaOps, maxBytes: MIN_DELTA_BYTES }));
    const pack = this.current;
    const ops = pack && journal.since(pack.seq);
    if (pack && ops) return { pack: pack.buffer, ops, seq: journal.seq };
    const seq = journal.seq;
    const buffer = packFileSystem(this.fs, seq);
    this.current = { buffer, seq };
    this.builds++;
    journal.trim(seq);
    journal.limit({ maxBytes: Math.max(MIN_DELTA_BYTES, buffer.byteLength * this.maxDeltaRatio) });
    return { pack: buffer, ops: [], seq };
  }

  /** Stop journaling and drop the pack. Further use throws: a disposed holder would hand out a stale file system. */
  dispose(): void {
    this.disposed = true;
    this.journal?.dispose();
    this.journal = undefined;
    this.current = undefined;
  }

  private live(): void {
    if (this.disposed) throw new Error('These snapshots were disposed; the file system is no longer tracked.');
  }
}

/** Load a snapshot into a new, empty file system (no change events; contents copied out on first read). */
export function mountSnapshot(fs: VirtualFileSystem, snapshot: VfsSnapshot): void {
  const { files, dirs } = readPack(snapshot.pack);
  fs.seed(files, dirs);
  applyOps(fs, snapshot.ops);
}
