/**
 * Hearing a program's file changes in an Emscripten file system that has no
 * `trackingDelegate` (php-wasm's build, Mono's browser-wasm runtime): the FS
 * calls every file operation goes through — `open` (a write flag), `write`,
 * `close`, `mkdir`, `unlink`, `rmdir`, `rename`, `symlink` — are wrapped, as
 * php-wasm's own fs-journal does, and fed to the project mirror's change
 * events (projectMirror.ts), which batch them out as VFS ops. Pyodide has the
 * hooks and feeds the same events from them instead (python/pyodideFs.ts).
 */
import type { VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import { absoluteIn, trackMountWrites, type EmscriptenFsCore, type MountWriteTracker } from './projectMirror.js';

/** A file stream in an Emscripten FS. */
export interface EmscriptenFsStream {
  path?: string;
}

/** An Emscripten FS without `trackingDelegate`: the mirror's calls plus the ones wrapped to hear the program's changes. */
export interface WrappableEmscriptenFs extends EmscriptenFsCore {
  open(path: string, flags: number | string, mode?: number): EmscriptenFsStream;
  write(stream: EmscriptenFsStream, ...rest: unknown[]): number;
  close(stream: EmscriptenFsStream): void;
  mkdir(path: string, mode?: number): unknown;
  rename(from: string, to: string): void;
  symlink(target: string, link: string): unknown;
}

const O_ACCMODE = 0o3;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

/** Emscripten's string modes (`'w'`, `'a+'`) as flags, for `FS.open` called with one. */
function writes(flags: number | string): boolean {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return (flags & O_ACCMODE) !== 0 || (flags & (O_CREAT | O_TRUNC)) !== 0;
}

/** Watch the file system under the project mount by wrapping its calls, and send the program's changes as VFS ops. */
export function trackWrappedFsWrites(FS: WrappableEmscriptenFs, send: (ops: VfsOp[]) => void): MountWriteTracker {
  const { tracker, events } = trackMountWrites(FS, send);
  const absolute = (path: string) => absoluteIn(FS, path);
  const original = { open: FS.open, write: FS.write, close: FS.close, mkdir: FS.mkdir, unlink: FS.unlink, rmdir: FS.rmdir, rename: FS.rename, symlink: FS.symlink };
  FS.open = function (this: unknown, path, flags, mode) {
    const stream = original.open.call(this, path, flags, mode);
    if (writes(flags) && stream.path) events.openedForWrite(stream.path);
    return stream;
  };
  FS.write = function (this: unknown, stream: EmscriptenFsStream, ...rest: unknown[]) {
    const written = original.write.call(this, stream, ...rest);
    if (stream.path) events.written(stream.path);
    return written;
  };
  FS.close = function (this: unknown, stream) {
    const path = stream.path;
    original.close.call(this, stream);
    if (path) events.closed(path);
  };
  FS.mkdir = function (this: unknown, path, mode) {
    const made = original.mkdir.call(this, path, mode);
    events.madeDirectory(absolute(path));
    return made;
  };
  FS.unlink = function (this: unknown, path) {
    original.unlink.call(this, path);
    events.deleted(absolute(path));
  };
  FS.rmdir = function (this: unknown, path) {
    original.rmdir.call(this, path);
    events.deleted(absolute(path));
  };
  FS.rename = function (this: unknown, from, to) {
    original.rename.call(this, from, to);
    events.moved(absolute(from), absolute(to));
  };
  FS.symlink = function (this: unknown, target, link) {
    const made = original.symlink.call(this, target, link);
    events.symlinked(absolute(link));
    return made;
  };
  return tracker;
}
