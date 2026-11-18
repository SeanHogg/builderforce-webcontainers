/**
 * The project's files inside php-wasm's file system, kept in step with the
 * page's both ways. The mirror is the one the Python runtime uses
 * (runtimes/emscripten/projectMirror.ts: the mount at `/project`, copying in,
 * replaying page ops, batching changes out). php-wasm's Emscripten build has
 * no `trackingDelegate`, so the program's changes are heard by wrapping the FS
 * calls every PHP file operation goes through — `open` (a write flag), `write`,
 * `close`, `mkdir`, `unlink`, `rmdir`, `rename`, `symlink` — as php-wasm's own
 * fs-journal does.
 */
import type { VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import { join } from '@seanhogg/builderforce-webcontainers-core';
import { trackMountWrites, type MountWriteTracker } from '../emscripten/projectMirror.js';
import type { PhpEmscriptenFs, PhpFsStream } from './phpLoader.js';

export { PROJECT_MOUNT, toMountPath as toPhpPath, fromMountPath as fromPhpPath, copyIntoMount as copyIntoPhp, applyOpsToMount as applyOpsToPhp } from '../emscripten/projectMirror.js';

const O_ACCMODE = 0o3;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

/** Emscripten's string modes (`'w'`, `'a+'`) as flags, for `FS.open` called with one. */
function writes(flags: number | string): boolean {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return (flags & O_ACCMODE) !== 0 || (flags & (O_CREAT | O_TRUNC)) !== 0;
}

/** Watch php-wasm's file system under the project and send PHP's changes as VFS ops. */
export function trackPhpWrites(FS: PhpEmscriptenFs, send: (ops: VfsOp[]) => void): MountWriteTracker {
  const { tracker, events } = trackMountWrites(FS, send);
  const absolute = (path: string) => (path.startsWith('/') ? path : join(FS.cwd(), path));
  const original = { open: FS.open, write: FS.write, close: FS.close, mkdir: FS.mkdir, unlink: FS.unlink, rmdir: FS.rmdir, rename: FS.rename, symlink: FS.symlink };
  FS.open = function (this: unknown, path, flags, mode) {
    const stream = original.open.call(this, path, flags, mode);
    if (writes(flags) && stream.path) events.openedForWrite(stream.path);
    return stream;
  };
  FS.write = function (this: unknown, stream: PhpFsStream, ...rest: unknown[]) {
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
