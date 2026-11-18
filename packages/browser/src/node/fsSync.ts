/**
 * Keeping every process's file system in step with the page's, which is the
 * authoritative one. The page's changes are batched per process (one `fs`
 * message per process per microtask), and a process's changes are applied to the
 * page's file system, from which every other process gets them. A process never
 * gets its own changes back. Promotions (an existing directory made explicit by
 * `mkdir`) travel too, so a mirror keeps the directories that outlive their files.
 *
 * It also holds the snapshots new unscoped processes start from (core
 * vfs/snapshots.ts): the same file system, the same op stream. Application
 * processes start from their view's snapshots (viewSupply.ts).
 *
 * A process's journal is untrusted input: an op that is not exactly one of the
 * journal's kinds is dropped (`fs.invalid_op`), and ops from a process not (or
 * no longer) added are dropped too — the page fails closed. A process of an
 * application has a view (fsScope.ts): it is sent only the changes it may see,
 * and its own changes are judged before the page applies them.
 *
 * A refused op cannot be reported to the process as an error: the protocol's
 * `fs` message (worker → page) has no answer. So the page reconciles instead: it
 * sends the sender, in its next `fs` batch, the page's truth for what it refused
 * (the page's content of a refused write or remove it may see, a remove of what
 * it may not), so its mirror never keeps a change no one else has. The write
 * itself still looked successful to the program. Surfacing EACCES needs a
 * page → worker message the protocol lacks (see the report: `fs-refused`).
 */
import {
  applyOps,
  changeToOp,
  isInsideDir,
  normalizePath,
  VfsSnapshots,
  type FsChange,
  type SecurityContext,
  type ShieldDecision,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';
import { isJournalOp, type FsView } from './fsScope.js';
import type { FsOp } from './protocol.js';

export interface FsSyncOptions<Peer> {
  /** Send a batch of the page's changes to a process. */
  send(peer: Peer, ops: FsOp[]): void;
  /** A process's op the page refused. Telemetry: what happens to the op does not depend on it. */
  onRefused?(context: SecurityContext | undefined, op: unknown, decision: ShieldDecision): void;
}

/** A scoped process: what it sees, and who it is (captured when it was added). */
export interface PeerScope {
  view?: FsView;
  context?: SecurityContext;
}

interface Outbox extends PeerScope {
  ops: FsOp[];
}

export class FsSync<Peer> {
  /** What each new unscoped process starts from: one pack reused until the project outgrows it, plus the ops since. */
  readonly snapshots: VfsSnapshots;
  /** Each running process, with the page's changes it has not been sent yet. */
  private readonly outboxes = new Map<Peer, Outbox>();
  private applyingFrom?: Peer;
  private flushScheduled = false;
  private readonly unwatch: () => void;

  constructor(private readonly fs: VirtualFileSystem, private readonly options: FsSyncOptions<Peer>) {
    this.snapshots = new VfsSnapshots(fs);
    this.unwatch = fs.watch((change) => this.onChange(change), { promotions: true });
  }

  /** Start sending changes to `peer` (a process just started from a snapshot taken now) — only those its view sees, when it has one. */
  add(peer: Peer, scope: PeerScope = {}): void {
    this.outboxes.set(peer, { ops: [], ...scope });
  }

  remove(peer: Peer): void {
    this.outboxes.delete(peer);
  }

  /** Send every pending batch now (before a spawn or an exit, so nothing is seen out of order). */
  flush(): void {
    this.flushScheduled = false;
    for (const [peer, outbox] of this.outboxes) {
      if (!outbox.ops.length) continue;
      const ops = outbox.ops;
      outbox.ops = [];
      this.options.send(peer, ops);
    }
  }

  /** Apply a process's changes to the page's file system (those it may make); every other process that may see them gets them. */
  applyFrom(peer: Peer, ops: readonly unknown[]): void {
    const outbox = this.outboxes.get(peer);
    if (!outbox || !Array.isArray(ops)) return; // not (or no longer) a process: fail closed
    const allowed: FsOp[] = [];
    const refused: FsOp[] = [];
    for (const op of ops) {
      const verdict = this.admit(outbox, op);
      if (verdict === 'apply') allowed.push(op as FsOp);
      else if (verdict === 'reconcile') refused.push(op as FsOp);
    }
    this.applyingFrom = peer;
    try {
      applyOps(this.fs, allowed);
    } finally {
      this.applyingFrom = undefined;
      // The page's truth once the batch is applied (so a later op of the batch is not undone), once per kind and path.
      const reconciled = new Set<string>();
      for (const op of refused) {
        const key = `${op.op === 'remove' ? 'remove' : 'set'}\n${normalizePath(op.path)}`;
        if (reconciled.has(key)) continue;
        reconciled.add(key);
        if (outbox.view) this.reconcile(outbox, outbox.view, op);
      }
    }
  }

  dispose(): void {
    this.unwatch();
    this.outboxes.clear();
    this.snapshots.dispose();
  }

  /** Apply the op, drop it, or refuse it and reconcile the sender's mirror (after the batch). */
  private admit(outbox: Outbox, op: unknown): 'apply' | 'drop' | 'reconcile' {
    if (!isJournalOp(op)) return (this.refuse(outbox, op, { allow: false, reason: 'fs.invalid_op' }), 'drop');
    if (!outbox.view) return 'apply';
    const verdict = outbox.view.judge(op);
    if (verdict === 'noop') return 'drop';
    if (verdict.allow) return 'apply';
    this.refuse(outbox, op, verdict);
    return 'reconcile';
  }

  private refuse(outbox: Outbox, op: unknown, decision: ShieldDecision): void {
    try {
      this.options.onRefused?.(outbox.context, op, decision);
    } catch {
      // Telemetry fails open: the op stays refused.
    }
  }

  /** Queue for the sender the page's truth at a path it was refused, so its mirror matches what everyone else has. */
  private reconcile(outbox: Outbox, view: FsView, op: FsOp): void {
    const path = normalizePath(op.path);
    const truth: FsOp[] = [];
    if (op.op === 'remove') {
      // Restore what it may see under what it tried to remove.
      for (const dir of this.fs.explicitDirectories()) if (isInsideDir(dir, path) && view.visible(dir)) truth.push({ op: 'mkdir', path: dir });
      for (const file of this.fs.list()) if (isInsideDir(file, path) && view.visible(file)) truth.push({ op: 'write', path: file, content: this.fs.readFile(file) ?? '' });
    } else if (!view.visible(path) || !this.fs.exists(path)) truth.push({ op: 'remove', path });
    else if (this.fs.isFile(path)) truth.push({ op: 'write', path, content: this.fs.readFile(path) ?? '' });
    if (!truth.length) return;
    outbox.ops.push(...truth);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private onChange(change: FsChange): void {
    const op = changeToOp(this.fs, change);
    for (const [peer, outbox] of this.outboxes) {
      if (peer !== this.applyingFrom && (!outbox.view || outbox.view.visible(change.path))) outbox.ops.push(op);
    }
    this.scheduleFlush();
  }
}
