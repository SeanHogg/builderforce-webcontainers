/**
 * The project's files inside an Emscripten file system (Pyodide's, php-wasm's),
 * kept in step with the page's both ways using the same ops every process
 * mirror speaks (core `VfsOp`). Shared by the Python and PHP runtimes: only how
 * a runtime *hears* its program's file changes differs (Pyodide has Emscripten's
 * `trackingDelegate` hooks, php-wasm's build has none and wraps FS methods), so
 * that part is a {@link FsChangeEvents} sink each runtime feeds.
 *
 * The project is mounted at {@link PROJECT_MOUNT}, so the runtime's own tree
 * (`/lib`, `/home/pyodide`, `/internal`, `/tmp`) never collides with a project
 * folder of the same name: VFS `/app.py` is `/project/app.py` inside.
 *
 * In: the start snapshot is mounted into a core `VirtualFileSystem` first
 * (`mountSnapshot`), then copied in; later page ops are replayed directly.
 * `node_modules` and `.git` are never copied in, either way.
 *
 * Out: a file is sent when it is closed, and also while it stays open — shortly
 * after writes stop, and on every `flush()` (before an exit) — so a log file a
 * server holds open still reaches the page. Truncation is tracked by wrapping
 * `FS.truncate`/`FS.ftruncate`. Changes go out once per microtask, one write
 * per path per batch, each carrying the file's whole content as it is when the
 * batch is sent. The VFS has no symbolic links: a link reaches the page as a
 * copy of what it points to.
 */
import { dirname, join, normalizePath, type VfsOp, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';

export const PROJECT_MOUNT = '/project';

/** Directories never mirrored into a runtime: a JavaScript frontend's dependencies, version control. */
export const UNMOUNTED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** How long after its last write an open file is sent anyway. */
export const OPEN_FILE_SYNC_MS = 50;

/** The Emscripten file-system calls the mirror makes (Pyodide's and php-wasm's `FS` both have them). */
export interface EmscriptenFsCore {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
  cwd(): string;
  /** Wrapped to track truncation, which no hook reports. */
  truncate(path: string, length: number): void;
  ftruncate(fd: number, length: number): void;
  getStream(fd: number): { path?: string } | null | undefined;
}

const isUnmounted = (path: string) => path.split('/').some((segment) => UNMOUNTED_DIRECTORIES.has(segment));

export const toMountPath = (vfsPath: string) => (vfsPath === '/' ? PROJECT_MOUNT : join(PROJECT_MOUNT, vfsPath));

/** The VFS path of a runtime path inside the project; undefined outside it. */
export function fromMountPath(path: string): string | undefined {
  const normalized = normalizePath(path);
  if (normalized === PROJECT_MOUNT) return '/';
  return normalized.startsWith(`${PROJECT_MOUNT}/`) ? normalized.slice(PROJECT_MOUNT.length) : undefined;
}

// A leading BOM is content, kept as is (a page tool rewriting the file must not drop it).
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text when it is UTF-8 (what the page's tools expect for source files), else the bytes. */
function contentOf(bytes: Uint8Array): string | Uint8Array {
  try {
    return utf8.decode(bytes);
  } catch {
    return bytes.slice();
  }
}

/** The FS helpers every Emscripten runtime shares (the PHP installer's file calls use them too). */
export const exists = (FS: EmscriptenFsCore, path: string) => FS.analyzePath(path).exists;
export const isDirectory = (FS: EmscriptenFsCore, path: string) => exists(FS, path) && FS.isDir(FS.stat(path).mode);
export const isFile = (FS: EmscriptenFsCore, path: string) => exists(FS, path) && !FS.isDir(FS.stat(path).mode);
/** A path the program gave (relative to its working directory, or absolute) as an absolute runtime path. */
export const absoluteIn = (FS: EmscriptenFsCore, path: string) => (path.startsWith('/') ? path : join(FS.cwd(), path));
export const childrenOf =(FS: EmscriptenFsCore, path: string) => FS.readdir(path).filter((name) => name !== '.' && name !== '..');

/** Remove a file or a directory tree. */
export function removeTree(FS: EmscriptenFsCore, path: string): void {
  if (!exists(FS, path)) return;
  if (!isDirectory(FS, path)) return FS.unlink(path);
  for (const name of childrenOf(FS, path)) removeTree(FS, `${path}/${name}`);
  FS.rmdir(path);
}

/** Copy the mounted snapshot (every file, every explicit directory) in under {@link PROJECT_MOUNT}. */
export function copyIntoMount(source: VirtualFileSystem, FS: EmscriptenFsCore): void {
  FS.mkdirTree(PROJECT_MOUNT);
  for (const dir of source.explicitDirectories()) if (!isUnmounted(dir)) FS.mkdirTree(toMountPath(dir));
  for (const path of source.list()) {
    if (isUnmounted(path)) continue;
    const target = toMountPath(path);
    FS.mkdirTree(dirname(target));
    FS.writeFile(target, source.readFile(path) ?? '');
  }
}

/** Replay the page's ops onto the runtime's file system. */
export function applyOpsToMount(FS: EmscriptenFsCore, ops: readonly VfsOp[]): void {
  for (const op of ops) {
    if (isUnmounted(op.path)) continue;
    const target = toMountPath(op.path);
    if (op.op === 'write') {
      FS.mkdirTree(dirname(target));
      if (isDirectory(FS, target)) removeTree(FS, target);
      FS.writeFile(target, op.content);
    } else if (op.op === 'mkdir') FS.mkdirTree(target);
    else removeTree(FS, target);
  }
}

/** The program's changes as they happen; `quietly` applies the page's own without echoing them back. */
export interface MountWriteTracker {
  quietly(apply: () => void): void;
  /** Send what is pending now, open files included (before an exit, so nothing is lost). */
  flush(): void;
}

/** What a runtime reports about its program's file changes (absolute runtime paths). */
export interface FsChangeEvents {
  /** A file was opened with a write flag. */
  openedForWrite(path: string): void;
  written(path: string): void;
  closed(path: string): void;
  /** Reported before the directory exists is fine: ops are read when the batch is sent. */
  madeDirectory(path: string): void;
  symlinked(link: string): void;
  deleted(path: string): void;
  moved(from: string, to: string): void;
}

/** `tree`: a path whose current state (a file, or a directory and all it holds) is sent as writes and mkdirs. */
type Pending = { op: 'write' | 'mkdir' | 'remove' | 'tree'; path: string };

/**
 * Watch the project under {@link PROJECT_MOUNT} and send its changes as VFS
 * ops. `ignore` drops VFS paths the runtime keeps to itself (bytecode caches).
 * The runtime feeds `events`; truncation is wrapped here.
 */
export function trackMountWrites(FS: EmscriptenFsCore, send: (ops: VfsOp[]) => void, ignore: (path: string) => boolean = () => false): { tracker: MountWriteTracker; events: FsChangeEvents } {
  /** Files open for writing, by runtime path. */
  const dirty = new Set<string>();
  let pending: Pending[] = [];
  let scheduled = false;
  let paused = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  /** Ops for a path as it is now; nothing for a path that is gone again (its remove follows). */
  const opsOf = (path: string, op: Pending['op']): VfsOp[] => {
    const mounted = toMountPath(path);
    if (op === 'mkdir' || op === 'remove') return [{ op, path }];
    if (!exists(FS, mounted)) return [];
    if (!isDirectory(FS, mounted)) return [{ op: 'write', path, content: contentOf(FS.readFile(mounted)) }];
    if (op === 'write') return [];
    return [{ op: 'mkdir', path }, ...childrenOf(FS, mounted).flatMap((name) => opsOf(join(path, name), 'tree'))];
  };
  const sendPending = () => {
    scheduled = false;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const ops = batch.flatMap(({ op, path }) => opsOf(path, op)).filter((op) => !ignore(op.path));
    if (ops.length) send(ops);
  };
  const queue = (op: Pending['op'], runtimePath: string) => {
    const path = fromMountPath(runtimePath);
    if (paused || path === undefined || path === '/' || ignore(path) || isUnmounted(path)) return;
    // Writing one file many times sends it once per batch (its content is read when the batch goes).
    if (op === 'write') {
      let latest: Pending | undefined;
      for (const entry of pending) if (entry.path === path) latest = entry;
      if (latest?.op === 'write') return;
    }
    pending.push({ op, path });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(sendPending);
    }
  };
  const queueOpenFiles = () => {
    for (const path of dirty) queue('write', path);
  };

  const events: FsChangeEvents = {
    // Paths outside the project (stdout's /dev/tty, /tmp) are ignored at once: no tracking, no timer re-armed per write.
    openedForWrite(path) {
      if (!paused && fromMountPath(path) !== undefined) dirty.add(path);
    },
    written(path) {
      if (paused || fromMountPath(path) === undefined) return;
      dirty.add(path);
      clearTimeout(idle);
      idle = setTimeout(queueOpenFiles, OPEN_FILE_SYNC_MS);
    },
    closed(path) {
      if (dirty.delete(path)) queue('write', path);
    },
    madeDirectory: (path) => queue('mkdir', path),
    symlinked: (link) => queue('tree', link),
    deleted: (path) => queue('remove', path),
    moved(from, to) {
      queue('remove', from);
      queue('tree', to);
    },
  };

  const truncate = FS.truncate.bind(FS);
  const ftruncate = FS.ftruncate.bind(FS);
  FS.truncate = (path, length) => {
    truncate(path, length);
    // `open(O_TRUNC)` truncates by node, not path; that open is tracked by its flags already.
    if (typeof path === 'string') queue('write', absoluteIn(FS, path));
  };
  FS.ftruncate = (fd, length) => {
    ftruncate(fd, length);
    const path = FS.getStream(fd)?.path;
    if (path) queue('write', path);
  };

  return {
    events,
    tracker: {
      quietly(apply) {
        paused++;
        try {
          apply();
        } finally {
          paused--;
        }
      },
      flush() {
        clearTimeout(idle);
        queueOpenFiles();
        sendPending();
      },
    },
  };
}
