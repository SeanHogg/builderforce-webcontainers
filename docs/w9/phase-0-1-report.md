# W9 Phases 0–1: process start-up cost

**Source:** Builderforce PRD 31 §W9, decision 7 and the phases table. Also webcontainers ROADMAP item 18.
**Date:** 2026-11-17
**Status:** Phase 1 is implemented. Repeat spawns now cost the same whatever the project size. The Next.js first-page time is still to be measured; it needs the browser harness (see "Open").

## Problem

Each process runs in its own Web Worker. Before this change, `ProcessHost.spawnChild` built a start message that held every file in the project:

```ts
files: fs.list().map((path) => [path, fs.readFile(path)!]),
dirs: fs.explicitDirectories(),
```

The page then structured-cloned that message: one string or `Uint8Array` per file, serialized on the page thread. The worker deserialized it and called `writeFile` once per file. All three steps grow with the project size, and every spawn repeated them. A shell running `node`, `next dev` starting its workers, or a three-service app each paid the cost again.

**Constraint.** The runtime never needs SharedArrayBuffer. Node's `fs` inside the worker is synchronous, so a worker cannot fetch a file from the page at the moment it is read. Every file therefore has to be in the worker before the program runs. The only things that can change are how the files are packaged and when they are sent.

## Design

The design has four parts, each in its own module.

1. **Change journal** (`core/src/vfs/journal.ts`, `VfsJournal`).
   - It records every change to the authoritative VFS, in order, numbered by a sequence. That sequence is the VFS's journal version.
   - Ops are `VfsOp`: `write` (create or update, with the content at that moment), `remove` and `mkdir`. These are the same ops running processes already exchange, so `protocol.ts`'s `FsOp` is now an alias of `VfsOp`.
   - A rename is recorded as the removes and writes it emits, which is exactly what watchers see.
   - New: `watch(…, { promotions: true })` also reports a `mkdir` that only turns an existing implicit directory into an explicit one. Before this, that change was silent. The old full snapshot carried it through `dirs`, so a replay must carry it too. Watchers that do not pass the option see no change in behaviour.
   - Promotions also travel live, both ways. The page's sync watcher (`browser/src/node/fsSync.ts`) and each worker's sync watcher pass `promotions: true`, so a directory made explicit on either side outlives its last file on the other side too. Applying a promoted `mkdir` on a mirror is idempotent. Before this, a running process lost such a directory once its files were removed, and so did the page when a worker promoted it.
   - Changes made inside a watcher are queued and reported after the change being reported (`VirtualFileSystem.emit`). Every listener therefore sees one order, and the journal can no longer record a nested `remove` before the `write` that caused it, an order the cached snapshot would otherwise have kept. `changeToOp` reads the content when the event is reported, so a file already removed again is written empty and then removed. The end state is the same.
   - The journal is bounded (`maxOps`, `maxBytes`). When it overflows, it drops what it holds, and `since(seq)` returns `undefined` for older sequences.
   - The two hand-written op↔VFS loops in `processHost.ts` and `workerProcess.ts` became the shared `changeToOp` / `applyOps`.

2. **Snapshot pack** (`core/src/vfs/pack.ts`). The whole file system is packed into one ArrayBuffer:
   - a header;
   - the UTF-16 length of each path;
   - a file table (kind, offset, length);
   - every path as UTF-16 code units;
   - then the contents.

   Text is stored as UTF-8. A string that is not well-formed (it has lone surrogates) keeps its UTF-16 code units, and bytes stay as bytes. Every value round-trips exactly, including a leading BOM (`ignoreBOM`). Handing the pack to a worker is one memcpy, not a structured clone of thousands of objects.

3. **Snapshots cached per version** (`core/src/vfs/snapshots.ts`, `VfsSnapshots`).
   - `snapshot()` returns the cached pack and the journal ops since it.
   - The journal starts at the first `snapshot()`. Its bounds are those of a snapshot: `maxDeltaOps` (1024) ops, and content of max(1 MB, 25 % of the pack), re-derived each time the pack is rebuilt. When the ops outgrow those bounds, the journal drops them and the next snapshot rebuilds the pack.
   - Spawns with no edit in between reuse the same `ArrayBuffer` and build nothing. An edit costs one op.
   - `mountSnapshot` seeds the worker's VFS from the pack index without emitting events, then replays the ops.
   - Every snapshot carries `seq`, the journal version a mirror is current at once it has mounted the snapshot.
   - Using the snapshots after `dispose()` throws, instead of handing out a stale pack.
   - The pack throws a `RangeError` when its contents pass 4 GiB, rather than letting the u32 offsets wrap.

4. **Copy-on-read mount** (`VirtualFileSystem.seed`).
   - A seeded file's contents can be a function, which is called on the first read and then replaced by its result.
   - The worker builds the path and directory index from the pack but decodes no file contents until a program opens the file.
   - The function is an instance property, so `RootedFileSystem` maps every public method as before. `rootedFs.test.ts` enforces that, and `seed` is mapped too.

5. **Warm spare Worker** (`browser/src/node/workerSupply.ts`, `WorkerSupply`).
   - After a spawn, one spare Worker is created on a later task (`setTimeout 0`), so it never adds to the spawn's latency. The spare is sent `{ type: 'prime', snapshot }`, so it loads its script and mounts the file system while nothing waits on it.
   - The worker acknowledges a mounted prime with `{ type: 'primed' }`. A spawn takes the spare only after that, and sends it only `snapshots.delta(spare.seq)`.
   - A spare that has not acknowledged yet stays the spare, and that spawn starts cold. A spare that failed, or whose ops the journal has dropped, is terminated, and that spawn starts cold. So a prime that fails asynchronously can never turn into a "Process worker failed" exit for a real process.
   - After `dispose()`, `take()` throws and no refill is armed.
   - Turn it off with `warmWorker: false` (`NodeRuntimeOptions` / `ProcessHostOptions`).
   - The spare is a `WorkerLike` from the same `createWorker`, so relay mode still starts it in the relay frame on the preview origin.

**Why this design and not the alternatives.**
- **Lazy fetch from the host:** a synchronous read would need `Atomics.wait`, which means SharedArrayBuffer. Ruled out.
- **OPFS:** synchronous access handles exist only in dedicated workers, are exclusive per file, and need async setup. They also make every read an I/O call. Ruled out.
- **Transferring the pack instead of cloning it:** the host would lose the cached buffer, and making a copy to transfer costs the same memcpy as the clone.
- **Pack plus deltas:** keeps the existing live-sync semantics, because the worker applies the same ops it already applies while running. The spare worker is what makes a spawn cost independent of project size.

6. **File-system sync, extracted** (`browser/src/node/fsSync.ts`, `FsSync`). The page↔process sync moved out of `ProcessHost`:
   - the per-process outboxes and their microtask flush;
   - `applyFrom`, which never echoes a change back to the process it came from;
   - the snapshots.

   `ProcessHost` keeps process lifecycle, ports and requests, ready for phase 4's connection routing. It shrank from 384 to 359 lines.

**Public surface** (`core` index): `VfsSnapshots`, `mountSnapshot`, `applyOps` and `changeToOp`, plus the types `VfsOp`, `VfsSnapshot`, `VfsDelta` and `SnapshotOptions`. The journal and the pack stay internal; tests import them from `src`.

**Also changed:** `normalizePath` now returns at once for a path that is already normal: one regex test instead of split and join. Every VFS call benefits, not just mounting. `tests/vfs/normalizePath.test.ts` checks it against the old algorithm on edge cases.

## Benchmark

```
cd packages/browser
node ../../node_modules/.pnpm/vite-node@2.1.9_@types+node@20.19.43_less@4.9.1_sass@1.105.2/node_modules/vite-node/vite-node.mjs scripts/spawn-bench.ts
BENCH_WARM=0 <same>   # every spawn cold
```

**How it works.** `scripts/spawn-bench.ts` drives the real `ProcessHost` through its public API only, so the same script runs before and after the change. It uses a Worker double:
- its `postMessage` is `structuredClone`, which is the browser's serialize on the page plus deserialize in the worker;
- it then runs the worker side's `receive(start)` inline.

**The project.** Files average about 1.5 KB; one file in ten is binary. The command does not exist, so the program part is a constant "command not found". Results are the median of 7 runs, in ms.

**Columns.**
- `total`: the whole `spawnChild` call.
- `snapshot`: total − clone − mount, i.e. what the page builds.
- `clone`: the structured clone.
- `mount`: the worker's handling of `start`.

**Script change after the baseline.** The baseline was recorded before the script waited 5 ms between spawns. That wait was added so a warm host can prime its spare. The old code had no spare, so the wait does not change what it measures.

**Environment.** Node v26.13.0 on an AMD Ryzen 7 7735HS under Windows 11. Other agents were running test suites at the same time, so individual numbers swing by up to 2×. Read the shape, not the decimals.

### Before (baseline, the code at the start of this task)

| files | scenario | total | snapshot | clone | mount |
|---|---|---|---|---|---|
| 100 | first spawn | 5.15 | 0.81 | 0.77 | 3.65 |
| 100 | repeat spawn | 4.83 | 0.97 | 0.47 | 3.55 |
| 100 | after 1 edit | 5.57 | 0.87 | 0.43 | 3.65 |
| 1 000 | first spawn | 42.20 | 5.86 | 9.56 | 27.02 |
| 1 000 | repeat spawn | 47.79 | 9.85 | 5.60 | 31.83 |
| 1 000 | after 1 edit | 38.81 | 9.20 | 5.73 | 27.32 |
| 10 000 | first spawn | 344.88 | 68.38 | 100.97 | 202.17 |
| 10 000 | repeat spawn | 299.80 | 85.39 | 54.50 | 167.91 |
| 10 000 | after 1 edit | 281.41 | 75.94 | 47.93 | 153.67 |

An earlier baseline run, on a busier machine, measured 10 000 files at 771 / 664 / 693 ms total. Every spawn costs O(project) on the page thread, and a repeat costs about the same as the first.

### After, default (warm spare on)

| files | scenario | total | snapshot | clone | mount |
|---|---|---|---|---|---|
Re-run after the review fixes: the spare is taken only once it has acknowledged its prime, and the journal is bounded by the snapshot's bounds.

| files | scenario | total | snapshot | clone | mount |
|---|---|---|---|---|---|
| 100 | first spawn | 4.71 | 2.28 | 0.44 | 1.97 |
| 100 | repeat spawn | 0.69 | 0.32 | 0.11 | 0.27 |
| 100 | after 1 edit | 1.13 | 0.25 | 0.12 | 0.31 |
| 1 000 | first spawn | 23.35 | 8.99 | 3.18 | 10.97 |
| 1 000 | repeat spawn | 0.36 | 0.14 | 0.08 | 0.12 |
| 1 000 | after 1 edit | 0.39 | 0.15 | 0.10 | 0.13 |
| 10 000 | first spawn | 233.42 | 121.55 | 25.97 | 66.45 |
| 10 000 | repeat spawn | 0.36 | 0.14 | 0.09 | 0.13 |
| 10 000 | after 1 edit | 0.38 | 0.13 | 0.11 | 0.13 |

The spare's `prime` happens between spawns, never inside one. Its clone takes 0.30 ms at 100 files, 2.64 ms at 1 000 and 18.55 ms at 10 000. Its mount runs in the spare Worker's own thread.

### After, every spawn cold (`BENCH_WARM=0`)

| files | scenario | total | snapshot | clone | mount |
|---|---|---|---|---|---|
| 100 | first spawn | 7.08 | 3.15 | 0.65 | 2.75 |
| 100 | repeat spawn | 4.62 | 0.51 | 0.60 | 3.20 |
| 100 | after 1 edit | 4.41 | 0.43 | 0.59 | 2.70 |
| 1 000 | first spawn | 19.55 | 7.44 | 3.23 | 9.05 |
| 1 000 | repeat spawn | 11.36 | 0.27 | 3.04 | 8.95 |
| 1 000 | after 1 edit | 12.22 | 0.18 | 3.30 | 8.85 |
| 10 000 | first spawn | 209.87 | 93.88 | 24.87 | 83.21 |
| 10 000 | repeat spawn | 104.19 | 0.24 | 26.42 | 77.51 |
| 10 000 | after 1 edit | 108.07 | 0.20 | 27.24 | 76.33 |

### Memory the journal pins

Before the fix, the journal recorded from the moment the process host was created. It held up to 4096 ops or 32 M characters of content, even though a snapshot can use at most 1024 ops or max(1 MB, 25 % of the pack). It also pinned content before any process had been started.

Now the journal starts at the first `snapshot()`, with exactly the snapshot's bounds. Examples:
- Files written before any process has run (a `writeTree` or `importZip` of 20 000 files) pin **0 bytes** in the journal. Before, the journal kept up to the last 4096 ops / 32 M characters of them.
- An npm install that writes 20 000 files after a process has run keeps at most the bounds below. Its ops are dropped each time they pass the bounds.
- For a 10 000-file project (pack about 13.6 MB), the journal holds at most **1024 ops and about 3.4 M characters** (max(1 MB, 25 % of the pack)).
- For a small project (pack under 4 MB), it holds at most **1024 ops and 1 M characters**.

`VfsSnapshots.journalBytes` reports the live figure.

### Reading

- **Spawn cost is flat in project size (the phase 1 exit criterion).** With the spare on, a repeat spawn, or a spawn after an edit, costs about 0.4–1.1 ms at 100, 1 000 and 10 000 files. Before, it was 5 / 48 / 300 ms.
- **Cold spawns:**
  - The page-side snapshot is flat: 0.2–0.5 ms, against 1–85 ms before.
  - The clone is one memcpy: about 2× faster than before at 10 000 files.
  - The worker's mount is proportional to the number of files (it builds the path index), but it decodes no file contents. It is about 2× faster than before.
- **The first spawn of a project version** still builds the pack. That is O(project), once per version, not once per spawn. At 10 000 files, the first spawn's total is below the baseline.
- **Not in this benchmark: loading a real Worker's script.** In a browser, a new process Worker has to fetch and evaluate `worker.js` before it can run anything. The warm spare does that work ahead of time as well, so in a browser the gain should be larger than this benchmark shows.

## Behaviour kept identical

- **File-system semantics** are unchanged: the same files, contents, explicit directories and errors.
- **Versions and mtimes:** a worker still assigns its own file versions and mtimes at mount, as it did with `writeFile` at start.
- **Watch events:**
  - Ordinary watchers see the same events as before.
  - One deliberate change: a change made inside a listener is now reported after the change being reported, not nested inside it.
  - Promotion events go only to watchers that pass `promotions: true`: the journal and the two sync watchers.
  - A worker's mount emits nothing, as before, when `applying` suppressed its own watcher.
- **Change propagation to running processes:** the outbox, the worker `fs` batches and the flush before a spawn are unchanged. They now live in `FsSync`. The op shape is the same, and promotions now travel too.
- **Relay mode:**
  - The spare comes from the same `createWorker`, so it is a process worker on the preview origin.
  - `workerOverPort` relays `prime` like any other message.
  - The pack is cloned through the MessagePort, and that is still one memcpy per hop.

## Tests

All the existing test files listed below pass. Their assertions were not changed.

**Core, targeted:**
- `tests/vfs.test.ts`, `tests/rootedFs.test.ts`;
- `tests/node/{runtime,builtins,httpStreaming,ipc}.test.ts`;
- `tests/resolution.test.ts`, `tests/devServer.test.ts`, `tests/hot.test.ts`, `tests/shell/*`.

These are the path-heavy and watcher-heavy tests that cover the `normalizePath` change and the emit queue.

Re-run after the review fixes:

```
Test Files  9 passed (9)   Tests  86 passed (86)    (vfs, rootedFs, node, new vfs/*)
Test Files  6 passed (6)   Tests  67 passed (67)    (resolution, devServer, hot, shell)
```

**Browser, targeted:**
- `tests/processHost.test.ts`, `tests/ipc.test.ts`, `tests/virtualServers.test.ts`, `tests/relayWorker.test.ts`;
- `tests/app-runtime.test.ts`, `tests/app-nodeProvider.test.ts` (both use the process host);
- the new `tests/spawnSnapshot.test.ts`.

```
Test Files  5 passed (5)   Tests  30 passed (30)    (processHost, spawnSnapshot, ipc, virtualServers, relayWorker)
Test Files  2 passed (2)   Tests  19 passed (19)    (app-runtime, app-nodeProvider)
```

**Typecheck** (`tsc --noEmit`, typescript-7) is clean in both packages.

**New tests:**
- `core/tests/vfs/pack.test.ts`:
  - round-trip of text, bytes, explicit directories and the sequence (including a sequence above 2^32);
  - exact strings: non-ASCII, a BOM, lone surrogates, empty files, odd paths;
  - bytes are copied out on read and are standalone;
  - lazy contents: mounting decodes nothing;
  - overwriting, removing and renaming seeded files before they are first read;
  - an empty pack, and a buffer that is not a pack.
- `core/tests/vfs/journal.test.ts`:
  - replaying create, update, delete and binary writes onto an older pack;
  - renames of files and directories;
  - promotion of an explicit directory, which ordinary watchers do not see and which passes through a rooted view;
  - trim, overflow and a sequence ahead of the journal;
  - byte accounting and dispose;
  - `VfsSnapshots` reusing the pack, sending ops after an edit, and rebuilding when the ops outgrow the op bound or the byte bound;
  - nothing pinned before the first snapshot, and the bounds holding after it;
  - use after dispose throws;
  - a watcher's nested remove is recorded after the write that caused it;
  - version skew (mount an old snapshot, then apply newer ops).
- `core/tests/vfs/normalizePath.test.ts`: the shortcut checked against the old algorithm, including paths with a newline before a trailing slash.
- `browser/tests/spawnSnapshot.test.ts`:
  - Cold: the snapshot is not rebuilt per spawn while the VFS is unchanged (`builds === 1`, the same `ArrayBuffer` sent). After an edit, the same pack plus the one op is sent, and the program sees the edit. Binary files, explicit empty directories and writes made by earlier processes reach a new process.
  - Promotions:
    - a promotion made on the page reaches a running process, so the directory outlives its last file there;
    - a process's `cpSync` onto an existing directory promotes it on the page, and the directory then survives the page removing its files, for later spawns too.
  - Warm:
    - a spare is primed after a spawn, and the next spawn takes it and sends only the ops;
    - a shell and its child both start warm (`warmStarts >= 2`) and see each other's writes;
    - with `warmWorker: false`, no spares are created;
    - `dispose()` terminates the spare, and a later spawn throws;
    - a spare whose prime failed is dropped, and that spawn starts cold;
    - a spare that has not acknowledged its prime is not taken, and stays the spare;
    - a spare whose ops the journal dropped (overflow) is dropped, and that spawn starts cold from a rebuilt pack.

## Open

- **Next.js first-page time against phase 0** (the PRD phase 1 exit condition). This needs the browser harness, which does not exist in this environment (see `docs/phase-0/00-baseline-report.md`). Measure it with `next dev` in a real browser, warm spare on and off.
- **The rest of phase 0:** virtual HTTP and WebSocket latency, and many Node processes running at once. These were not measured here.
- **Memory:**
  - A worker keeps its pack buffer alive (about the size of the project), plus the contents it has read. On the page, the journal is now bounded (see "Memory the journal pins").
  - The spare holds one more mirror of the project.
  - Releasing the pack once every file has been read, or once the pack is rebuilt, is a possible refinement.
- **The 4 GiB guard in the pack has no test.** A test would have to allocate a 4 GiB buffer.
- **The cold mount is still proportional to the number of files** (it builds the index). Making it fully lazy would need a layered VFS (base pack plus overlay plus whiteouts). The warm spare already takes the mount off the critical path, so that work is not needed for the exit criterion.
