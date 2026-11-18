/**
 * The project's files inside Pyodide's (Emscripten) file system, kept in step
 * with the page's both ways using the same ops every process mirror speaks
 * (core `VfsOp`). The project is mounted at {@link PROJECT_MOUNT}, so Python's
 * own tree (`/lib`, `/home/pyodide`, `/tmp`) never collides with a project
 * folder of the same name: VFS `/app.py` is `/project/app.py` in Python.
 *
 * In: the start snapshot is mounted into a core `VirtualFileSystem` first
 * (`mountSnapshot`), then copied in; later page ops are replayed directly.
 * `node_modules` and `.git` are never copied in, either way.
 *
 * Out: Emscripten's tracking hooks report what Python opened for writing,
 * created, deleted, moved and linked; truncation (which has no hook) is
 * tracked by wrapping `FS.truncate`/`FS.ftruncate`. A file is sent when it is
 * closed, and also while it stays open — shortly after writes stop, and on
 * every `flush()` (before an exit) — so a log file a server holds open still
 * reaches the page. Changes go out once per microtask, one write per path per
 * batch, each carrying the file's whole content as it is when the batch is
 * sent. The VFS has no symbolic links: a link Python makes reaches the page as
 * a copy of what it points to.
 */
import { dirname, join, normalizePath, type VfsOp, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { EmscriptenFs } from './pyodideLoader.js';

export const PROJECT_MOUNT = '/project';

/** Directories never mirrored into Python: a JavaScript frontend's dependencies, version control. */
export const UNMOUNTED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** How long after its last write an open file is sent anyway. */
export const OPEN_FILE_SYNC_MS = 50;

/** Bytecode caches stay inside Python (the runtime also sets `PYTHONDONTWRITEBYTECODE`). */
const isBytecode = (path: string) => path.includes('/__pycache__') || path.endsWith('.pyc');
const isUnmounted = (path: string) => path.split('/').some((segment) => UNMOUNTED_DIRECTORIES.has(segment));

export const toPyodidePath = (vfsPath: string) => (vfsPath === '/' ? PROJECT_MOUNT : join(PROJECT_MOUNT, vfsPath));

/** The VFS path of a Pyodide path inside the project; undefined outside it. */
export function fromPyodidePath(path: string): string | undefined {
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

const exists = (FS: EmscriptenFs, path: string) => FS.analyzePath(path).exists;
const isDirectory = (FS: EmscriptenFs, path: string) => exists(FS, path) && FS.isDir(FS.stat(path).mode);
const childrenOf = (FS: EmscriptenFs, path: string) => FS.readdir(path).filter((name) => name !== '.' && name !== '..');

/** Remove a file or a directory tree. */
function removeTree(FS: EmscriptenFs, path: string): void {
  if (!exists(FS, path)) return;
  if (!isDirectory(FS, path)) return FS.unlink(path);
  for (const name of childrenOf(FS, path)) removeTree(FS, `${path}/${name}`);
  FS.rmdir(path);
}

/** Copy the mounted snapshot (every file, every explicit directory) into Pyodide under {@link PROJECT_MOUNT}. */
export function copyIntoPyodide(source: VirtualFileSystem, FS: EmscriptenFs): void {
  FS.mkdirTree(PROJECT_MOUNT);
  for (const dir of source.explicitDirectories()) if (!isUnmounted(dir)) FS.mkdirTree(toPyodidePath(dir));
  for (const path of source.list()) {
    if (isUnmounted(path)) continue;
    const target = toPyodidePath(path);
    FS.mkdirTree(dirname(target));
    FS.writeFile(target, source.readFile(path) ?? '');
  }
}

/** Replay the page's ops onto Pyodide's file system. */
export function applyOpsToPyodide(FS: EmscriptenFs, ops: readonly VfsOp[]): void {
  for (const op of ops) {
    if (isUnmounted(op.path)) continue;
    const target = toPyodidePath(op.path);
    if (op.op === 'write') {
      FS.mkdirTree(dirname(target));
      if (isDirectory(FS, target)) removeTree(FS, target);
      FS.writeFile(target, op.content);
    } else if (op.op === 'mkdir') FS.mkdirTree(target);
    else removeTree(FS, target);
  }
}

/** Python's changes as they happen; `quietly` applies the page's own without echoing them back. */
export interface PyodideWriteTracker {
  quietly(apply: () => void): void;
  /** Send what is pending now, open files included (before an exit, so nothing is lost). */
  flush(): void;
}

const WRITE_FLAGS = 0o1 | 0o2 | 0o100 | 0o1000; // O_WRONLY | O_RDWR | O_CREAT | O_TRUNC

/** `tree`: a path whose current state (a file, or a directory and all it holds) is sent as writes and mkdirs. */
type Pending = { op: 'write' | 'mkdir' | 'remove' | 'tree'; path: string };

/** Watch Pyodide's file system under the project and send its changes as VFS ops. */
export function trackPyodideWrites(FS: EmscriptenFs, send: (ops: VfsOp[]) => void): PyodideWriteTracker {
  /** Files open for writing, by Pyodide path. */
  const dirty = new Set<string>();
  let pending: Pending[] = [];
  let scheduled = false;
  let paused = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  /** Ops for a path as it is now; nothing for a path that is gone again (its remove follows). */
  const opsOf = (path: string, op: Pending['op']): VfsOp[] => {
    const pyPath = toPyodidePath(path);
    if (op === 'mkdir' || op === 'remove') return [{ op, path }];
    if (!exists(FS, pyPath)) return [];
    if (!isDirectory(FS, pyPath)) return [{ op: 'write', path, content: contentOf(FS.readFile(pyPath)) }];
    if (op === 'write') return [];
    return [{ op: 'mkdir', path }, ...childrenOf(FS, pyPath).flatMap((name) => opsOf(join(path, name), 'tree'))];
  };
  const send$ = () => {
    scheduled = false;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const ops = batch.flatMap(({ op, path }) => opsOf(path, op)).filter((op) => !isBytecode(op.path));
    if (ops.length) send(ops);
  };
  const queue = (op: Pending['op'], pyPath: string) => {
    const path = fromPyodidePath(pyPath);
    if (paused || path === undefined || path === '/' || isBytecode(path) || isUnmounted(path)) return;
    // Writing one file many times sends it once per batch (its content is read when the batch goes).
    if (op === 'write') {
      let latest: Pending | undefined;
      for (const entry of pending) if (entry.path === path) latest = entry;
      if (latest?.op === 'write') return;
    }
    pending.push({ op, path });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(send$);
    }
  };
  const queueOpenFiles = () => {
    for (const path of dirty) queue('write', path);
  };
  const absolute = (path: string) => (path.startsWith('/') ? path : join(FS.cwd(), path));

  const hooks: Record<string, (...args: never[]) => void> = {
    onOpenFile: ((path: string, flags: number) => {
      if (!paused && flags & WRITE_FLAGS) dirty.add(path);
    }) as never,
    onWriteToFile: ((path: string) => {
      if (paused) return;
      dirty.add(path);
      clearTimeout(idle);
      idle = setTimeout(queueOpenFiles, OPEN_FILE_SYNC_MS);
    }) as never,
    onCloseFile: ((path: string) => {
      if (dirty.delete(path)) queue('write', path);
    }) as never,
    // Called before the directory exists; the op is read when the batch is sent, after it does.
    onMakeDirectory: ((path: string) => queue('mkdir', path)) as never,
    onMakeSymlink: ((_target: string, link: string) => queue('tree', link)) as never,
    onDeletePath: ((path: string) => queue('remove', path)) as never,
    onMovePath: ((from: string, to: string) => {
      queue('remove', from);
      queue('tree', to);
    }) as never,
  };
  Object.assign(FS.trackingDelegate, hooks);
  const truncate = FS.truncate.bind(FS);
  const ftruncate = FS.ftruncate.bind(FS);
  FS.truncate = (path, length) => {
    truncate(path, length);
    // `open(O_TRUNC)` truncates by node, not path; that open is tracked by its flags already.
    if (typeof path === 'string') queue('write', absolute(path));
  };
  FS.ftruncate = (fd, length) => {
    ftruncate(fd, length);
    const path = FS.getStream(fd)?.path;
    if (path) queue('write', path);
  };

  return {
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
      send$();
    },
  };
}
