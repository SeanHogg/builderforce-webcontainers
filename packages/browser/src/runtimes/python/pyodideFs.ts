/**
 * The project's files inside Pyodide's (Emscripten) file system, kept in step
 * with the page's both ways. The mirror itself — the mount at
 * {@link PROJECT_MOUNT}, copying in, replaying page ops, batching changes out —
 * is shared with the PHP runtime (runtimes/emscripten/projectMirror.ts); what
 * is Pyodide's own is how changes are heard: Emscripten's tracking hooks report
 * what Python opened for writing, wrote, closed, created, deleted, moved and
 * linked. Bytecode caches stay inside Python (the runtime also sets
 * `PYTHONDONTWRITEBYTECODE`).
 */
import type { VfsOp, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { applyOpsToMount, copyIntoMount, fromMountPath, toMountPath, trackMountWrites, type MountWriteTracker } from '../emscripten/projectMirror.js';
import type { EmscriptenFs } from './pyodideLoader.js';

export { PROJECT_MOUNT, UNMOUNTED_DIRECTORIES, OPEN_FILE_SYNC_MS } from '../emscripten/projectMirror.js';

export const toPyodidePath = toMountPath;

/** The VFS path of a Pyodide path inside the project; undefined outside it. */
export const fromPyodidePath = fromMountPath;

/** Copy the mounted snapshot (every file, every explicit directory) into Pyodide under {@link PROJECT_MOUNT}. */
export function copyIntoPyodide(source: VirtualFileSystem, FS: EmscriptenFs): void {
  copyIntoMount(source, FS);
}

/** Replay the page's ops onto Pyodide's file system. */
export function applyOpsToPyodide(FS: EmscriptenFs, ops: readonly VfsOp[]): void {
  applyOpsToMount(FS, ops);
}

/** Python's changes as they happen; `quietly` applies the page's own without echoing them back. */
export type PyodideWriteTracker = MountWriteTracker;

const WRITE_FLAGS = 0o1 | 0o2 | 0o100 | 0o1000; // O_WRONLY | O_RDWR | O_CREAT | O_TRUNC

const isBytecode = (path: string) => path.includes('/__pycache__') || path.endsWith('.pyc');

/** Watch Pyodide's file system under the project and send its changes as VFS ops. */
export function trackPyodideWrites(FS: EmscriptenFs, send: (ops: VfsOp[]) => void): PyodideWriteTracker {
  const { tracker, events } = trackMountWrites(FS, send, isBytecode);
  const hooks: Record<string, (...args: never[]) => void> = {
    onOpenFile: ((path: string, flags: number) => {
      if (flags & WRITE_FLAGS) events.openedForWrite(path);
    }) as never,
    onWriteToFile: ((path: string) => events.written(path)) as never,
    onCloseFile: ((path: string) => events.closed(path)) as never,
    onMakeDirectory: ((path: string) => events.madeDirectory(path)) as never,
    onMakeSymlink: ((_target: string, link: string) => events.symlinked(link)) as never,
    onDeletePath: ((path: string) => events.deleted(path)) as never,
    onMovePath: ((from: string, to: string) => events.moved(from, to)) as never,
  };
  Object.assign(FS.trackingDelegate, hooks);
  return tracker;
}
