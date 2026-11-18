/**
 * The change journal of an authoritative file system: every state change, in
 * order, numbered by a sequence (the file system's journal version). A mirror
 * that holds the state at sequence N becomes current by replaying the ops after
 * N — which is how a new process starts from a cached snapshot pack, and the
 * same ops (`VfsOp`) are what running processes already exchange to stay in sync.
 *
 * Ops are recorded from change events, so a rename is the removes and writes it
 * emits, exactly what watchers see. A `mkdir` that only makes an existing
 * directory explicit is recorded too (`promotions`), so a replay reproduces
 * which directories outlive their last file.
 *
 * Bounded: past `maxOps` ops or `maxBytes` of contents since the oldest one kept,
 * the journal drops what it holds and `since` answers undefined for older
 * sequences — the snapshot holder rebuilds its pack instead of replaying.
 */
import type { FileContent, FsChange, VirtualFileSystem } from '../vfs.js';

/** One state change, as data that crosses a postMessage. */
export type VfsOp = { op: 'write'; path: string; content: FileContent } | { op: 'remove'; path: string } | { op: 'mkdir'; path: string };

export interface JournalOptions {
  /** Ops kept before the journal resets. Default 4096. */
  maxOps?: number;
  /** Content bytes kept (string length for text) before the journal resets. Default 32 MB. */
  maxBytes?: number;
}

/** A change event as the op that replays it (the content read now, at the event). */
export function changeToOp(fs: VirtualFileSystem, change: FsChange): VfsOp {
  return change.type === 'write' ? { op: 'write', path: change.path, content: fs.readFile(change.path)! } : { op: change.type, path: change.path };
}

/** Replay ops onto a mirror, in order. */
export function applyOps(fs: VirtualFileSystem, ops: readonly VfsOp[]): void {
  for (const op of ops) {
    if (op.op === 'write') fs.writeFile(op.path, op.content);
    else if (op.op === 'mkdir') fs.mkdir(op.path);
    else fs.rm(op.path);
  }
}

/** Content bytes an op holds (string length for text: a cheap, stable estimate). */
export function opBytes(op: VfsOp): number {
  if (op.op !== 'write') return op.path.length;
  return typeof op.content === 'string' ? op.content.length : op.content.byteLength;
}

export class VfsJournal {
  private ops: VfsOp[] = [];
  /** Sequence of the change before `ops[0]`: ops cover (base, seq]. */
  private base = 0;
  private bytes = 0;
  private current = 0;
  private readonly maxOps: number;
  private readonly maxBytes: number;
  private readonly unwatch: () => void;

  constructor(private readonly fs: VirtualFileSystem, options: JournalOptions = {}) {
    this.maxOps = options.maxOps ?? 4096;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.unwatch = fs.watch((change) => this.record(change), { promotions: true });
  }

  /** The sequence of the last change recorded: the file system's journal version. */
  get seq(): number {
    return this.current;
  }

  /** The ops after sequence `from`, in order; undefined when some were dropped (or `from` is ahead). */
  since(from: number): VfsOp[] | undefined {
    if (from < this.base || from > this.current) return undefined;
    return this.ops.slice(from - this.base);
  }

  /** Content bytes held by the ops after `from` (0 when `since(from)` is undefined). */
  bytesSince(from: number): number {
    const ops = this.since(from);
    if (!ops) return 0;
    return from === this.base ? this.bytes : ops.reduce((sum, op) => sum + opBytes(op), 0);
  }

  /** Forget the ops up to and including `upTo`: nobody will replay from before it. */
  trim(upTo: number): void {
    const drop = Math.min(Math.max(upTo - this.base, 0), this.ops.length);
    if (!drop) return;
    for (const op of this.ops.slice(0, drop)) this.bytes -= opBytes(op);
    this.ops = this.ops.slice(drop);
    this.base += drop;
  }

  dispose(): void {
    this.unwatch();
    this.ops = [];
    this.bytes = 0;
    this.base = this.current;
  }

  private record(change: FsChange): void {
    const op = changeToOp(this.fs, change);
    this.current++;
    this.ops.push(op);
    this.bytes += opBytes(op);
    if (this.ops.length > this.maxOps || this.bytes > this.maxBytes) {
      this.ops = [];
      this.bytes = 0;
      this.base = this.current;
    }
  }
}
