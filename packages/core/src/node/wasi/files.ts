/**
 * WASI file descriptors over the process's `fs`: stdio on 0–2, one descriptor per
 * preopened directory from 3, and the files and directories `path_open` opens
 * relative to them. Every call answers a WASI errno and writes its results into the
 * module's memory.
 */
import { normalizePath } from '../../paths.js';
import { ALL_RIGHTS, ERRNO, FDFLAGS, FILETYPE, Memory, OFLAGS, WHENCE, errnoOf } from './abi.js';

/** The slice of Node's `fs` this needs; the process's own module satisfies it. */
export interface WasiFs {
  statSync(path: string, options?: { throwIfNoEntry?: boolean }): { isDirectory(): boolean; size: number; mtimeMs: number; ino?: number } | undefined;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array | string): void;
  readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  mkdirSync(path: string): void;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
}

export interface WasiStdio {
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
}

interface Descriptor {
  kind: 'stdio' | 'dir' | 'file';
  /** Absolute path in the file system (directories and files). */
  path: string;
  /** The guest-visible name of a preopened directory. */
  preopen?: string;
  position: number;
  append: boolean;
}

const FILESTAT_SIZE = 64;

export function createWasiFiles(fs: WasiFs, stdio: WasiStdio, memory: Memory, preopens: Record<string, string>) {
  const fds = new Map<number, Descriptor>([
    [0, { kind: 'stdio', path: '', position: 0, append: false }],
    [1, { kind: 'stdio', path: '', position: 0, append: false }],
    [2, { kind: 'stdio', path: '', position: 0, append: false }],
  ]);
  let nextFd = 3;
  for (const [guest, host] of Object.entries(preopens)) fds.set(nextFd++, { kind: 'dir', path: normalizePath(host), preopen: guest, position: 0, append: false });

  const resolveAt = (dirFd: number, at: number, length: number): string | number => {
    const dir = fds.get(dirFd);
    if (!dir) return ERRNO.BADF;
    if (dir.kind !== 'dir') return ERRNO.NOTDIR;
    const relative = memory.text(at, length);
    return normalizePath(relative.startsWith('/') ? relative : `${dir.path}/${relative}`);
  };

  /** Run an fs operation, answering its failure as an errno. */
  const attempt = (fn: () => number | void): number => {
    try {
      return fn() ?? ERRNO.SUCCESS;
    } catch (error) {
      return errnoOf(error);
    }
  };

  const writeFilestat = (at: number, stat: { isDirectory(): boolean; size: number; mtimeMs: number; ino?: number }, kind?: number) => {
    const view = memory.view;
    memory.bytes(at, FILESTAT_SIZE).fill(0);
    view.setBigUint64(at + 8, BigInt(stat.ino ?? 0), true);
    view.setUint8(at + 16, kind ?? (stat.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE));
    view.setBigUint64(at + 24, 1n, true);
    view.setBigUint64(at + 32, BigInt(stat.size), true);
    const time = BigInt(Math.round(stat.mtimeMs)) * 1_000_000n;
    for (const offset of [40, 48, 56]) view.setBigUint64(at + offset, time, true);
  };

  const readInto = (file: Descriptor, buffers: Uint8Array[], position: number): number => {
    const contents = fs.readFileSync(file.path);
    let at = position;
    for (const buffer of buffers) {
      const chunk = contents.subarray(at, at + buffer.length);
      buffer.set(chunk);
      at += chunk.length;
      if (chunk.length < buffer.length) break;
    }
    return at - position;
  };

  const writeFrom = (file: Descriptor, buffers: Uint8Array[], position: number): number => {
    const current = fs.statSync(file.path, { throwIfNoEntry: false }) ? fs.readFileSync(file.path) : new Uint8Array();
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    const next = new Uint8Array(Math.max(current.length, position + total));
    next.set(current);
    let at = position;
    for (const buffer of buffers) {
      next.set(buffer, at);
      at += buffer.length;
    }
    fs.writeFileSync(file.path, next);
    return total;
  };

  return {
    fd_write(fd: number, iovs: number, count: number, written: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      const buffers = memory.iovecs(iovs, count);
      return attempt(() => {
        let n: number;
        if (file.kind === 'stdio') {
          const bytes = concat(buffers);
          if (fd === 1) stdio.stdout(bytes);
          else if (fd === 2) stdio.stderr(bytes);
          else return ERRNO.BADF;
          n = bytes.length;
        } else if (file.kind === 'file') {
          const at = file.append ? fs.statSync(file.path)?.size ?? 0 : file.position;
          n = writeFrom(file, buffers, at);
          file.position = at + n;
        } else return ERRNO.ISDIR;
        memory.view.setUint32(written, n, true);
      });
    },

    fd_pwrite(fd: number, iovs: number, count: number, offset: bigint, written: number): number {
      const file = fds.get(fd);
      if (!file || file.kind !== 'file') return file ? ERRNO.INVAL : ERRNO.BADF;
      return attempt(() => void memory.view.setUint32(written, writeFrom(file, memory.iovecs(iovs, count), Number(offset)), true));
    },

    fd_read(fd: number, iovs: number, count: number, read: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      return attempt(() => {
        // stdin reads as end of input: a WASI module cannot wait on the event loop.
        const n = file.kind === 'file' ? readInto(file, memory.iovecs(iovs, count), file.position) : file.kind === 'stdio' ? 0 : -1;
        if (n < 0) return ERRNO.ISDIR;
        file.position += n;
        memory.view.setUint32(read, n, true);
      });
    },

    fd_pread(fd: number, iovs: number, count: number, offset: bigint, read: number): number {
      const file = fds.get(fd);
      if (!file || file.kind !== 'file') return file ? ERRNO.INVAL : ERRNO.BADF;
      return attempt(() => void memory.view.setUint32(read, readInto(file, memory.iovecs(iovs, count), Number(offset)), true));
    },

    fd_seek(fd: number, offset: bigint, whence: number, result: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      if (file.kind !== 'file') return ERRNO.INVAL;
      return attempt(() => {
        const base = whence === WHENCE.SET ? 0 : whence === WHENCE.CUR ? file.position : whence === WHENCE.END ? fs.statSync(file.path)?.size ?? 0 : -1;
        if (base < 0 || base + Number(offset) < 0) return ERRNO.INVAL;
        file.position = base + Number(offset);
        memory.view.setBigUint64(result, BigInt(file.position), true);
      });
    },

    fd_tell(fd: number, result: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      memory.view.setBigUint64(result, BigInt(file.position), true);
      return ERRNO.SUCCESS;
    },

    fd_close(fd: number): number {
      return fds.delete(fd) ? ERRNO.SUCCESS : ERRNO.BADF;
    },

    fd_fdstat_get(fd: number, at: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      const view = memory.view;
      view.setUint8(at, file.kind === 'stdio' ? FILETYPE.CHARACTER_DEVICE : file.kind === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
      view.setUint16(at + 2, file.append ? FDFLAGS.APPEND : 0, true);
      view.setBigUint64(at + 8, ALL_RIGHTS, true);
      view.setBigUint64(at + 16, ALL_RIGHTS, true);
      return ERRNO.SUCCESS;
    },

    fd_fdstat_set_flags(fd: number, flags: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      file.append = (flags & FDFLAGS.APPEND) !== 0;
      return ERRNO.SUCCESS;
    },

    fd_filestat_get(fd: number, at: number): number {
      const file = fds.get(fd);
      if (!file) return ERRNO.BADF;
      if (file.kind === 'stdio') {
        writeFilestat(at, { isDirectory: () => false, size: 0, mtimeMs: 0 }, FILETYPE.CHARACTER_DEVICE);
        return ERRNO.SUCCESS;
      }
      return attempt(() => writeFilestat(at, fs.statSync(file.path)!));
    },

    fd_filestat_set_size(fd: number, size: bigint): number {
      const file = fds.get(fd);
      if (!file || file.kind !== 'file') return file ? ERRNO.INVAL : ERRNO.BADF;
      return attempt(() => {
        const current = fs.readFileSync(file.path);
        const next = new Uint8Array(Number(size));
        next.set(current.subarray(0, next.length));
        fs.writeFileSync(file.path, next);
      });
    },

    fd_prestat_get(fd: number, at: number): number {
      const file = fds.get(fd);
      if (!file?.preopen) return ERRNO.BADF;
      memory.view.setUint8(at, 0); // a directory
      memory.view.setUint32(at + 4, new TextEncoder().encode(file.preopen).length, true);
      return ERRNO.SUCCESS;
    },

    fd_prestat_dir_name(fd: number, at: number, length: number): number {
      const file = fds.get(fd);
      if (!file?.preopen) return ERRNO.BADF;
      memory.bytes(at, length).set(new TextEncoder().encode(file.preopen).subarray(0, length));
      return ERRNO.SUCCESS;
    },

    fd_readdir(fd: number, buffer: number, length: number, cookie: bigint, used: number): number {
      const dir = fds.get(fd);
      if (!dir) return ERRNO.BADF;
      if (dir.kind !== 'dir') return ERRNO.NOTDIR;
      return attempt(() => {
        const entries = fs.readdirSync(dir.path, { withFileTypes: true });
        const view = memory.view;
        let at = 0;
        for (let i = Number(cookie); i < entries.length && at < length; i++) {
          const entry = entries[i]!;
          const name = new TextEncoder().encode(entry.name);
          const record = new Uint8Array(24 + name.length);
          const header = new DataView(record.buffer);
          header.setBigUint64(0, BigInt(i + 1), true);
          header.setUint32(16, name.length, true);
          header.setUint8(20, entry.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
          record.set(name, 24);
          // A record that does not fit is cut short: the caller sees a full buffer and asks again.
          const fits = Math.min(record.length, length - at);
          memory.bytes(buffer + at, fits).set(record.subarray(0, fits));
          at += fits;
        }
        view.setUint32(used, at, true);
      });
    },

    path_open(dirFd: number, _dirFlags: number, at: number, length: number, oflags: number, _base: bigint, _inheriting: bigint, fdflags: number, result: number): number {
      const path = resolveAt(dirFd, at, length);
      if (typeof path === 'number') return path;
      return attempt(() => {
        const stat = fs.statSync(path, { throwIfNoEntry: false });
        if (stat && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return ERRNO.EXIST;
        if (!stat && !(oflags & OFLAGS.CREAT)) return ERRNO.NOENT;
        if (stat?.isDirectory()) {
          if (oflags & OFLAGS.TRUNC) return ERRNO.ISDIR;
        } else if (oflags & OFLAGS.DIRECTORY) return stat ? ERRNO.NOTDIR : ERRNO.NOENT;
        if (!stat || oflags & OFLAGS.TRUNC) fs.writeFileSync(path, new Uint8Array());
        const fd = nextFd++;
        fds.set(fd, { kind: stat?.isDirectory() ? 'dir' : 'file', path, position: 0, append: (fdflags & FDFLAGS.APPEND) !== 0 });
        memory.view.setUint32(result, fd, true);
      });
    },

    path_filestat_get(dirFd: number, _flags: number, at: number, length: number, result: number): number {
      const path = resolveAt(dirFd, at, length);
      if (typeof path === 'number') return path;
      return attempt(() => {
        const stat = fs.statSync(path, { throwIfNoEntry: false });
        if (!stat) return ERRNO.NOENT;
        writeFilestat(result, stat);
      });
    },

    path_create_directory(dirFd: number, at: number, length: number): number {
      const path = resolveAt(dirFd, at, length);
      return typeof path === 'number' ? path : attempt(() => fs.mkdirSync(path));
    },

    path_remove_directory(dirFd: number, at: number, length: number): number {
      const path = resolveAt(dirFd, at, length);
      return typeof path === 'number' ? path : attempt(() => fs.rmdirSync(path));
    },

    path_unlink_file(dirFd: number, at: number, length: number): number {
      const path = resolveAt(dirFd, at, length);
      return typeof path === 'number' ? path : attempt(() => fs.unlinkSync(path));
    },

    path_rename(fromFd: number, fromAt: number, fromLength: number, toFd: number, toAt: number, toLength: number): number {
      const from = resolveAt(fromFd, fromAt, fromLength);
      const to = resolveAt(toFd, toAt, toLength);
      if (typeof from === 'number') return from;
      if (typeof to === 'number') return to;
      return attempt(() => fs.renameSync(from, to));
    },

    fd_sync: (fd: number) => (fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_datasync: (fd: number) => (fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_advise: (fd: number) => (fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_allocate: (fd: number) => (fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF),
    fd_filestat_set_times: (fd: number) => (fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF),
    path_filestat_set_times: () => ERRNO.SUCCESS,
  };
}

function concat(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 1) return buffers[0]!.slice();
  const out = new Uint8Array(buffers.reduce((sum, b) => sum + b.length, 0));
  let at = 0;
  for (const b of buffers) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
