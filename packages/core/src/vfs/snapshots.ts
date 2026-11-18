/**
 * Snapshots for new processes, cheap to hand over and reused across spawns.
 *
 * The authoritative file system keeps a change journal. A snapshot is the
 * cached pack (one ArrayBuffer, see pack.ts) taken at some journal sequence plus
 * the journal ops since then; the pack is rebuilt only when the ops since it
 * outgrow it (or the journal dropped them). So spawning N processes without an
 * edit in between builds one pack, and an edit costs one small op, not a new
 * copy of the project.
 *
 * A process mounts a snapshot into its own file system: the pack's index is
 * seeded (contents read on first open), then the ops replayed in order — the
 * same replay that keeps a running process in sync. A process host may mount a
 * snapshot into a Worker ahead of time (a warm worker) and later start it with
 * only the `delta` since then.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { VfsJournal, applyOps, type JournalOptions, type VfsOp } from './journal.js';
import { packFileSystem, readPack } from './pack.js';

/** What a new process starts from: the pack and the changes made after it. */
export interface VfsSnapshot {
  pack: ArrayBuffer;
  ops: VfsOp[];
}

/** What a process that already mounted a snapshot (a warm worker) starts from: only the ops since. */
export interface VfsDelta {
  pack?: undefined;
  ops: VfsOp[];
}

export interface SnapshotOptions extends JournalOptions {
  /** Rebuild the pack once more ops than this accumulated after it. Default 1024. */
  maxDeltaOps?: number;
  /** ...or once their contents exceed this share of the pack's size (never below 1 MB). Default 0.25. */
  maxDeltaRatio?: number;
}

const MIN_DELTA_BYTES = 1024 * 1024;

export class VfsSnapshots {
  private readonly journal: VfsJournal;
  private current?: { buffer: ArrayBuffer; seq: number };
  private readonly maxDeltaOps: number;
  private readonly maxDeltaRatio: number;
  /** Packs built so far: one per change of the project that outgrew the journal, not one per spawn. */
  builds = 0;

  constructor(private readonly fs: VirtualFileSystem, options: SnapshotOptions = {}) {
    this.journal = new VfsJournal(fs, options);
    this.maxDeltaOps = options.maxDeltaOps ?? 1024;
    this.maxDeltaRatio = options.maxDeltaRatio ?? 0.25;
  }

  /** The file system's journal sequence (its version). */
  get seq(): number {
    return this.journal.seq;
  }

  /**
   * The ops that bring a mirror current at sequence `seq` up to now — for a
   * process that already mounted a snapshot (a warm worker). Undefined when the
   * journal no longer holds them or they outgrew the pack: start from a snapshot.
   */
  delta(seq: number): VfsOp[] | undefined {
    const ops = this.journal.since(seq);
    return ops && !this.outgrown(this.current?.buffer, seq, ops) ? ops : undefined;
  }

  /** The file system as it is now, as a cached pack plus the ops since it. */
  snapshot(): VfsSnapshot {
    const pack = this.current;
    const ops = pack && this.journal.since(pack.seq);
    if (pack && ops && !this.outgrown(pack.buffer, pack.seq, ops)) return { pack: pack.buffer, ops };
    const seq = this.journal.seq;
    this.current = { buffer: packFileSystem(this.fs, seq), seq };
    this.builds++;
    this.journal.trim(seq);
    return { pack: this.current.buffer, ops: [] };
  }

  dispose(): void {
    this.journal.dispose();
    this.current = undefined;
  }

  private outgrown(buffer: ArrayBuffer | undefined, seq: number, ops: VfsOp[]): boolean {
    if (ops.length > this.maxDeltaOps) return true;
    return this.journal.bytesSince(seq) > Math.max(MIN_DELTA_BYTES, (buffer?.byteLength ?? 0) * this.maxDeltaRatio);
  }
}

/** Load a snapshot into a new, empty file system (no change events; contents copied out on first read). */
export function mountSnapshot(fs: VirtualFileSystem, snapshot: VfsSnapshot): void {
  const { files, dirs } = readPack(snapshot.pack);
  fs.seed(files, dirs);
  applyOps(fs, snapshot.ops);
}
