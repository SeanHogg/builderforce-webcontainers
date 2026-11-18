import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, type FsChange } from '../../src/vfs.js';
import { VfsJournal, applyOps, type VfsOp } from '../../src/vfs/journal.js';
import { packFileSystem } from '../../src/vfs/pack.js';
import { VfsSnapshots, mountSnapshot } from '../../src/vfs/snapshots.js';
import { rootedFileSystem } from '../../src/rootedFs.js';

function state(fs: VirtualFileSystem) {
  return { files: fs.list().map((path) => [path, fs.readFile(path)]), dirs: fs.explicitDirectories() };
}

/** A mirror built from a pack taken at `seq` plus the journal's ops since then. */
function replay(fs: VirtualFileSystem, journal: VfsJournal, pack: ArrayBuffer, seq: number): VirtualFileSystem {
  const mirror = new VirtualFileSystem();
  mountSnapshot(mirror, { pack, ops: journal.since(seq)!, seq: journal.seq });
  return mirror;
}

describe('VfsJournal', () => {
  it('numbers every change and replays creates, updates, removes and binary writes onto an older pack', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'a', src: { 'b.ts': 'b', 'c.ts': 'c' } });
    const journal = new VfsJournal(fs);
    const pack = packFileSystem(fs, journal.seq);
    const at = journal.seq;
    fs.writeFile('/a.txt', 'a2'); // update
    fs.writeFile('/new.bin', new Uint8Array([7, 8])); // create, binary
    fs.rm('/src/c.ts'); // delete
    expect(journal.seq).toBe(at + 3);
    expect(journal.since(at)!.map((op) => op.op)).toEqual(['write', 'write', 'remove']);
    expect(state(replay(fs, journal, pack, at))).toEqual(state(fs));
  });

  it('replays renames of files and directories (removes, then writes) and explicit directories', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ src: { 'a.ts': 'a', deep: { 'b.ts': 'b' } }, 'x.txt': 'x' });
    fs.mkdir('/src/empty');
    const journal = new VfsJournal(fs);
    const pack = packFileSystem(fs, journal.seq);
    const at = journal.seq;
    fs.rename('/src', '/lib');
    fs.rename('/x.txt', '/lib/x.txt');
    fs.rm('/lib/empty');
    expect(state(replay(fs, journal, pack, at))).toEqual(state(fs));
  });

  it('records a mkdir that only makes an existing directory explicit, so a replay keeps it after its files go', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/dist/out.js', '1');
    const journal = new VfsJournal(fs);
    const pack = packFileSystem(fs, journal.seq);
    const at = journal.seq;
    fs.mkdir('/dist'); // silent to ordinary watchers
    fs.rm('/dist/out.js');
    expect(fs.isDirectory('/dist')).toBe(true);
    const mirror = replay(fs, journal, pack, at);
    expect(mirror.isDirectory('/dist')).toBe(true);
    expect(state(mirror)).toEqual(state(fs));
  });

  it('keeps ordinary watchers unchanged: no event for a promotion, unless asked for', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/dist/out.js', '1');
    const plain: FsChange[] = [];
    const all: FsChange[] = [];
    fs.watch((change) => plain.push(change));
    fs.watch((change) => all.push(change), { promotions: true });
    fs.mkdir('/dist');
    fs.mkdir('/dist'); // already explicit: nothing at all
    expect(plain).toEqual([]);
    expect(all).toEqual([{ type: 'mkdir', path: '/dist', promoted: true }]);
  });

  it('passes promotions through a rooted view', () => {
    const base = new VirtualFileSystem();
    const view = rootedFileSystem(base, '/home/project');
    view.writeFile('/dist/out.js', '1');
    const seen: FsChange[] = [];
    view.watch((change) => seen.push(change), { promotions: true });
    view.mkdir('/dist');
    expect(seen).toEqual([{ type: 'mkdir', path: '/dist', promoted: true }]);
  });

  it('answers undefined for a sequence it no longer holds, after trim or overflow, and for one ahead of it', () => {
    const fs = new VirtualFileSystem();
    const journal = new VfsJournal(fs, { maxOps: 3 });
    fs.writeFile('/a', '1');
    fs.writeFile('/b', '2');
    expect(journal.since(0)).toHaveLength(2);
    expect(journal.since(5)).toBeUndefined();
    journal.trim(1);
    expect(journal.since(0)).toBeUndefined();
    expect(journal.since(1)).toEqual([{ op: 'write', path: '/b', content: '2' }]);
    fs.writeFile('/c', '3');
    fs.writeFile('/d', '4');
    fs.writeFile('/e', '5'); // past maxOps: dropped
    expect(journal.since(1)).toBeUndefined();
    expect(journal.since(journal.seq)).toEqual([]);
  });

  it('counts the content bytes it holds', () => {
    const fs = new VirtualFileSystem();
    const journal = new VfsJournal(fs, { maxBytes: 10 });
    fs.writeFile('/a', 'abcd');
    fs.writeFile('/b', new Uint8Array(3));
    expect(journal.bytesSince(0)).toBe(7);
    expect(journal.bytesSince(1)).toBe(3);
    fs.writeFile('/c', 'abcdefgh'); // 15 bytes > 10: dropped
    expect(journal.since(0)).toBeUndefined();
    expect(journal.bytesSince(journal.seq)).toBe(0);
  });

  it('stops recording when disposed', () => {
    const fs = new VirtualFileSystem();
    const journal = new VfsJournal(fs);
    journal.dispose();
    fs.writeFile('/a', '1');
    expect(journal.seq).toBe(0);
  });
});

describe('VfsSnapshots', () => {
  it('reuses one pack across snapshots while nothing changes, then sends only the ops since it', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a.txt': 'a', 'b.txt': 'b' });
    const snapshots = new VfsSnapshots(fs);
    const first = snapshots.snapshot();
    const second = snapshots.snapshot();
    expect(snapshots.builds).toBe(1);
    expect(second.pack).toBe(first.pack);
    expect(second.ops).toEqual([]);
    fs.writeFile('/a.txt', 'A');
    const third = snapshots.snapshot();
    expect(snapshots.builds).toBe(1);
    expect(third.pack).toBe(first.pack);
    expect(third.ops).toEqual([{ op: 'write', path: '/a.txt', content: 'A' }]);
    const mirror = new VirtualFileSystem();
    mountSnapshot(mirror, third);
    expect(state(mirror)).toEqual(state(fs));
  });

  it('rebuilds the pack once the ops since it outgrow it (the journal drops them)', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a', 'a');
    const snapshots = new VfsSnapshots(fs, { maxDeltaOps: 2 });
    snapshots.snapshot();
    fs.writeFile('/f0', '0');
    fs.writeFile('/f1', '1');
    expect(snapshots.snapshot().ops).toHaveLength(2); // at the bound: still a delta
    fs.writeFile('/f2', '2');
    const rebuilt = snapshots.snapshot();
    expect(snapshots.builds).toBe(2);
    expect(rebuilt.ops).toEqual([]);
    const mirror = new VirtualFileSystem();
    mountSnapshot(mirror, rebuilt);
    expect(state(mirror)).toEqual(state(fs));
  });

  it('rebuilds once the content since the pack exceeds max(1 MB, the ratio of the pack)', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/big', 'x'.repeat(8 * 1024 * 1024));
    const snapshots = new VfsSnapshots(fs, { maxDeltaRatio: 0.25 });
    snapshots.snapshot();
    fs.writeFile('/edit', 'y'.repeat(1024 * 1024)); // 1 MB < 2 MB (25% of 8 MB)
    expect(snapshots.snapshot().ops).toHaveLength(1);
    fs.writeFile('/edit2', 'z'.repeat(1024 * 1024 + 1000)); // past 25% of the pack (8 MB + its index)
    expect(snapshots.snapshot().ops.length).toBe(0);
    expect(snapshots.builds).toBe(2);
  });

  it('pins nothing before the first snapshot, and only up to its bounds after', () => {
    const fs = new VirtualFileSystem();
    const snapshots = new VfsSnapshots(fs, { maxDeltaOps: 4 });
    for (let i = 0; i < 100; i++) fs.writeFile(`/pre${i}`, 'p'.repeat(1000));
    expect(snapshots.journalBytes).toBe(0);
    snapshots.snapshot();
    for (let i = 0; i < 3; i++) fs.writeFile(`/post${i}`, 'q'.repeat(10));
    expect(snapshots.journalBytes).toBe(30);
    for (let i = 3; i < 10; i++) fs.writeFile(`/post${i}`, 'q'.repeat(10));
    expect(snapshots.journalBytes).toBeLessThanOrEqual(40); // dropped at 5 ops, holding at most 4 after
    expect(snapshots.delta(0)).toBeUndefined();
  });

  it('refuses to be used after dispose rather than hand out a stale file system', () => {
    const fs = new VirtualFileSystem();
    const snapshots = new VfsSnapshots(fs);
    snapshots.snapshot();
    snapshots.dispose();
    expect(() => snapshots.snapshot()).toThrow(/disposed/);
    expect(() => snapshots.delta(0)).toThrow(/disposed/);
  });

  it('records changes made by a watcher after the change it reacted to (one order for every listener)', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/seed', 's');
    // Registered before the journal: it removes a temp file as soon as it is written.
    fs.watch((change) => {
      if (change.type === 'write' && change.path === '/tmp') fs.rm('/tmp');
    });
    const seen: string[] = [];
    fs.watch((change) => seen.push(`${change.type} ${change.path}`));
    const snapshots = new VfsSnapshots(fs);
    const base = snapshots.snapshot();
    fs.writeFile('/tmp', 'scratch');
    expect(seen).toEqual(['write /tmp', 'remove /tmp']);
    const { ops } = snapshots.snapshot();
    expect(ops.map((op) => `${op.op} ${op.path}`)).toEqual(['write /tmp', 'remove /tmp']);
    const mirror = new VirtualFileSystem();
    mountSnapshot(mirror, { ...base, ops });
    expect(state(mirror)).toEqual(state(fs));
  });

  it('a mirror kept in sync with the same ops stays equal to the source (version skew: mount old, apply newer)', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ src: { 'a.ts': 'a' } });
    const snapshots = new VfsSnapshots(fs);
    const snapshot = snapshots.snapshot();
    const live: VfsOp[] = [];
    const journal = new VfsJournal(fs);
    fs.writeFile('/src/b.ts', 'b');
    fs.rename('/src/a.ts', '/src/c.ts');
    live.push(...journal.since(0)!);
    const mirror = new VirtualFileSystem();
    mountSnapshot(mirror, snapshot);
    applyOps(mirror, live);
    expect(state(mirror)).toEqual(state(fs));
  });
});
