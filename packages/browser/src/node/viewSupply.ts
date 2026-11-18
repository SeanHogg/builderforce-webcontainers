/**
 * Where an application process's Worker and snapshot come from (control 8 with
 * the flat-cost spawns of make.md W9): per file-system view (fsScope.ts), a
 * mirror holding only what the view sees, kept in step with the page's file
 * system op by op, and its own snapshots and Worker supply over it — the same
 * `VfsSnapshots` (cached pack + journal ops) and `WorkerSupply` (a primed warm
 * spare, then deltas) the unscoped processes use. So spawning a service's
 * processes again costs a delta, not a re-pack, and nothing outside the view is
 * ever in the pack or a spare.
 *
 * The mirror shares contents with the page's file system (it holds the same
 * strings and byte arrays, which are replaced, never mutated). A view whose
 * visibility changed (`FsView.revision`) is rebuilt on its next spawn.
 */
import { VfsSnapshots, VirtualFileSystem, applyOps, changeToOp, type FsChange, type VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import type { FsView } from './fsScope.js';
import type { WorkerLike } from './processHost.js';
import type { WorkerKind } from './protocol.js';
import { WorkerSupply } from './workerSupply.js';

interface ViewEntry {
  mirror: VirtualFileSystem;
  snapshots: VfsSnapshots;
  supply: WorkerSupply;
  revision: number;
}

/** A new file system holding what `view` sees of `fs`. */
export function mirrorOf(fs: VirtualFileSystem, view: FsView): VirtualFileSystem {
  const mirror = new VirtualFileSystem();
  mirror.seed(
    fs
      .list()
      .filter((path) => view.visible(path))
      .map((path) => [path, fs.readFile(path) ?? ''] as const),
    fs.explicitDirectories().filter((path) => view.visible(path)),
  );
  return mirror;
}

export class ViewSupplies {
  private readonly entries = new Map<FsView, ViewEntry>();
  private readonly unwatch: () => void;
  private disposed = false;

  constructor(
    private readonly fs: VirtualFileSystem,
    /** Told the view's application, so its Workers start on that application's preview origin. */
    private readonly createWorker: (kind: WorkerKind, applicationId: string) => WorkerLike,
    /** Keep a primed spare per view, like the unscoped supply. */
    private readonly warm: boolean,
  ) {
    this.unwatch = fs.watch((change) => this.onChange(change), { promotions: true });
  }

  /** The Worker supply for processes with `view`: a primed spare of that view when there is one. */
  supplyFor(view: FsView): WorkerSupply {
    if (this.disposed) throw new Error('The process host was disposed.');
    let entry = this.entries.get(view);
    if (entry && entry.revision !== view.revision) {
      this.drop(entry);
      entry = undefined;
    }
    if (!entry) {
      const mirror = mirrorOf(this.fs, view);
      const snapshots = new VfsSnapshots(mirror);
      entry = { mirror, snapshots, supply: new WorkerSupply((kind) => this.createWorker(kind, view.applicationId), snapshots, this.warm), revision: view.revision };
      this.entries.set(view, entry);
    }
    return entry.supply;
  }

  /** Application `applicationId` ended: drop its views' mirrors, snapshots and spares. */
  release(applicationId: string): void {
    for (const [view, entry] of this.entries) {
      if (view.applicationId !== applicationId) continue;
      this.drop(entry);
      this.entries.delete(view);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unwatch();
    for (const entry of this.entries.values()) this.drop(entry);
    this.entries.clear();
  }

  private drop(entry: ViewEntry): void {
    entry.supply.dispose();
    entry.snapshots.dispose();
  }

  private onChange(change: FsChange): void {
    let op: VfsOp | undefined;
    for (const [view, entry] of this.entries) {
      if (!view.visible(change.path)) continue;
      try {
        applyOps(entry.mirror, [(op ??= changeToOp(this.fs, change))]);
      } catch {
        // A mirror that cannot follow is rebuilt from the page's file system on its next spawn.
        this.drop(entry);
        this.entries.delete(view);
      }
    }
  }
}
