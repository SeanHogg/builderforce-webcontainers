/**
 * The synchronous fs API over the VirtualFileSystem. Everything else (callback,
 * promise and stream forms) is layered on these in index.ts, so error codes and
 * edge cases live in exactly one place.
 */
import type { VirtualFileSystem } from '../../vfs.js';
import { normalizePath, dirname, join } from '../../paths.js';
import { Buffer, encode } from '../buffer.js';
import { Dirent, fsError, Stats, constants } from './stats.js';

export interface FsContext {
  vfs: VirtualFileSystem;
  cwd(): string;
  /** fd 1 and 2: `fs.writeSync(1, …)` is how some CLIs print. */
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
}

type PathLike = string | Uint8Array | URL;
type Data = string | ArrayBufferView;
type EncodingOption = string | null | undefined | { encoding?: string | null; flag?: string; withFileTypes?: boolean; recursive?: boolean; force?: boolean; mode?: number; throwIfNoEntry?: boolean };

interface OpenFile {
  path: string;
  flags: string;
  position: number;
}

const encodingOf = (options: EncodingOption): string | null | undefined => (typeof options === 'string' ? options : options?.encoding);

export function createSyncFs(ctx: FsContext) {
  const { vfs } = ctx;
  const fds = new Map<number, OpenFile>();
  let nextFd = 20;

  const resolve = (p: PathLike): string => {
    if (p instanceof URL) {
      if (p.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
      return normalizePath(decodeURIComponent(p.pathname));
    }
    const text = typeof p === 'string' ? p : new TextDecoder().decode(p);
    if (typeof text !== 'string') throw new TypeError('The "path" argument must be of type string, Buffer or URL');
    if (text.startsWith('file://')) return normalizePath(decodeURIComponent(new URL(text).pathname));
    return text.startsWith('/') ? normalizePath(text) : join(ctx.cwd(), text);
  };

  const bytesOf = (path: string): Uint8Array => {
    const contents = vfs.readFile(path)!;
    return typeof contents === 'string' ? encode(contents) : contents;
  };

  const requireParent = (path: string, syscall: string) => {
    const parent = dirname(path);
    if (vfs.isFile(parent)) throw fsError('ENOTDIR', syscall, path);
    if (!vfs.isDirectory(parent)) throw fsError('ENOENT', syscall, path);
  };

  const toStored = (data: Data, encoding?: string | null): string | Uint8Array => {
    if (typeof data === 'string') return !encoding || /^utf-?8$/i.test(encoding) ? data : encode(data, encoding).slice();
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  };

  const stat = (p: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined => {
    const path = resolve(p);
    if (vfs.isFile(path)) return new Stats(path, 'file', bytesOf(path).length, vfs.mtime(path) ?? Date.now());
    if (vfs.isDirectory(path)) return new Stats(path, 'directory', 4096, 0);
    if (options?.throwIfNoEntry === false) return undefined;
    throw fsError('ENOENT', 'stat', path);
  };

  const writeFile = (p: PathLike | number, data: Data, options?: EncodingOption) => {
    if (typeof p === 'number') return writeFd(p, data);
    const path = resolve(p);
    const flag = typeof options === 'object' && options ? options.flag ?? 'w' : 'w';
    if (vfs.isDirectory(path)) throw fsError('EISDIR', 'open', path);
    requireParent(path, 'open');
    if (flag.includes('x') && vfs.isFile(path)) throw fsError('EEXIST', 'open', path);
    if (flag.startsWith('a') && vfs.isFile(path)) {
      const before = vfs.readFile(path)!;
      const add = toStored(data, encodingOf(options));
      vfs.writeFile(path, typeof before === 'string' && typeof add === 'string' ? before + add : Buffer.concat([typeof before === 'string' ? encode(before) : before, typeof add === 'string' ? encode(add) : add]));
      return;
    }
    vfs.writeFile(path, toStored(data, encodingOf(options)));
  };

  const writeFd = (fd: number, data: Data | Uint8Array, offset?: number | string | null, length?: number, position?: number | null): number => {
    const bytes = typeof data === 'string' ? encode(data, typeof offset === 'string' ? offset : undefined) : new Uint8Array(data.buffer, data.byteOffset + (typeof offset === 'number' ? offset : 0), length ?? data.byteLength - (typeof offset === 'number' ? offset : 0));
    if (fd === 1 || fd === 2) {
      (fd === 1 ? ctx.stdout : ctx.stderr)(bytes.slice());
      return bytes.length;
    }
    const file = fds.get(fd);
    if (!file || file.flags === 'r') throw fsError('EBADF', 'write');
    const current = vfs.isFile(file.path) ? bytesOf(file.path) : new Uint8Array();
    const at = file.flags.startsWith('a') ? current.length : position ?? file.position;
    const next = new Uint8Array(Math.max(current.length, at + bytes.length));
    next.set(current);
    next.set(bytes, at);
    vfs.writeFile(file.path, next);
    if (position === undefined || position === null) file.position = at + bytes.length;
    return bytes.length;
  };

  const readdirEntries = (dir: string, recursive: boolean, prefix = ''): Array<{ name: string; parent: string; kind: 'file' | 'directory' }> => {
    const out: Array<{ name: string; parent: string; kind: 'file' | 'directory' }> = [];
    for (const name of vfs.readdir(dir)) {
      const full = join(dir, name);
      const kind = vfs.isDirectory(full) ? 'directory' : 'file';
      out.push({ name: prefix + name, parent: dir, kind });
      if (recursive && kind === 'directory') out.push(...readdirEntries(full, true, `${prefix}${name}/`));
    }
    return out;
  };

  const mkdir = (p: PathLike, options?: EncodingOption | number): string | undefined => {
    const path = resolve(p);
    const recursive = typeof options === 'object' && !!options?.recursive;
    if (vfs.isFile(path)) throw fsError('EEXIST', 'mkdir', path);
    if (vfs.isDirectory(path)) {
      if (recursive) return undefined;
      throw fsError('EEXIST', 'mkdir', path);
    }
    if (!recursive) requireParent(path, 'mkdir');
    let first: string | undefined;
    for (let dir = path; !vfs.isDirectory(dir); dir = dirname(dir)) {
      if (vfs.isFile(dir)) throw fsError('ENOTDIR', 'mkdir', path);
      first = dir;
    }
    vfs.mkdir(path);
    return recursive ? first : undefined;
  };

  const rm = (p: PathLike, options?: { recursive?: boolean; force?: boolean }) => {
    const path = resolve(p);
    if (!vfs.exists(path)) {
      if (options?.force) return;
      throw fsError('ENOENT', 'rm', path);
    }
    if (vfs.isDirectory(path) && !options?.recursive) throw Object.assign(fsError('EISDIR', 'rm', path), { code: 'ERR_FS_EISDIR' });
    vfs.rm(path);
  };

  const copyFile = (src: PathLike, dest: PathLike, mode = 0) => {
    const from = resolve(src);
    const to = resolve(dest);
    if (!vfs.isFile(from)) throw fsError(vfs.isDirectory(from) ? 'EISDIR' : 'ENOENT', 'copyfile', from, to);
    if (mode & constants.COPYFILE_EXCL && vfs.exists(to)) throw fsError('EEXIST', 'copyfile', from, to);
    requireParent(to, 'copyfile');
    const contents = vfs.readFile(from)!;
    vfs.writeFile(to, typeof contents === 'string' ? contents : contents.slice());
  };

  const copyTree = (from: string, to: string) => {
    if (vfs.isFile(from)) {
      const contents = vfs.readFile(from)!;
      vfs.writeFile(to, typeof contents === 'string' ? contents : contents.slice());
      return;
    }
    vfs.mkdir(to);
    for (const name of vfs.readdir(from)) copyTree(join(from, name), join(to, name));
  };

  const open = (p: PathLike, flags: string | number = 'r'): number => {
    const path = resolve(p);
    const f = typeof flags === 'number' ? (flags & constants.O_APPEND ? 'a' : flags & (constants.O_WRONLY | constants.O_RDWR) ? 'w' : 'r') : flags;
    if (vfs.isDirectory(path) && f !== 'r') throw fsError('EISDIR', 'open', path);
    if (f.startsWith('r')) {
      if (!vfs.exists(path)) throw fsError('ENOENT', 'open', path);
    } else {
      if (f.includes('x') && vfs.exists(path)) throw fsError('EEXIST', 'open', path);
      requireParent(path, 'open');
      if (f.startsWith('w') || !vfs.isFile(path)) vfs.writeFile(path, '');
    }
    const fd = nextFd++;
    fds.set(fd, { path, flags: f, position: 0 });
    return fd;
  };

  const fileOf = (fd: number, syscall: string) => {
    const file = fds.get(fd);
    if (!file) throw fsError('EBADF', syscall);
    return file;
  };

  const api = {
    existsSync: (p: PathLike) => {
      try {
        return vfs.exists(resolve(p));
      } catch {
        return false;
      }
    },
    accessSync(p: PathLike) {
      const path = resolve(p);
      if (!vfs.exists(path)) throw fsError('ENOENT', 'access', path);
    },
    statSync: stat,
    lstatSync: stat,
    fstatSync: (fd: number) => stat(fileOf(fd, 'fstat').path)!,
    readFileSync(p: PathLike | number, options?: EncodingOption): string | Buffer {
      if (p === 0) return Buffer.alloc(0); // stdin is not readable synchronously here
      const path = typeof p === 'number' ? fileOf(p, 'read').path : resolve(p);
      if (vfs.isDirectory(path)) throw fsError('EISDIR', 'read', path);
      const contents = vfs.readFile(path);
      if (contents === undefined) throw fsError('ENOENT', 'open', path);
      const encoding = encodingOf(options);
      if (encoding) return typeof contents === 'string' && /^utf-?8$/i.test(encoding) ? contents : Buffer.from(typeof contents === 'string' ? encode(contents) : contents).toString(encoding as 'utf8');
      return Buffer.from(typeof contents === 'string' ? encode(contents) : contents);
    },
    writeFileSync: writeFile,
    appendFileSync: (p: PathLike | number, data: Data, options?: EncodingOption) => writeFile(p, data, { ...(typeof options === 'string' ? { encoding: options } : options ?? {}), flag: 'a' }),
    mkdirSync: mkdir,
    mkdtempSync(prefix: string) {
      const path = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
      mkdir(path);
      return resolve(path);
    },
    readdirSync(p: PathLike, options?: EncodingOption) {
      const path = resolve(p);
      if (vfs.isFile(path)) throw fsError('ENOTDIR', 'scandir', path);
      if (!vfs.isDirectory(path)) throw fsError('ENOENT', 'scandir', path);
      const opts = typeof options === 'object' ? options : undefined;
      const entries = readdirEntries(path, !!opts?.recursive);
      if (opts?.withFileTypes) return entries.map((e) => new Dirent(e.name.slice(e.name.lastIndexOf('/') + 1), e.name.includes('/') ? join(path, e.name, '..') : e.parent, e.kind));
      return entries.map((e) => (encodingOf(options) === 'buffer' ? Buffer.from(e.name) : e.name));
    },
    rmSync: rm,
    rmdirSync(p: PathLike, options?: { recursive?: boolean }) {
      const path = resolve(p);
      if (vfs.isFile(path)) throw fsError('ENOTDIR', 'rmdir', path);
      if (!vfs.isDirectory(path)) throw fsError('ENOENT', 'rmdir', path);
      if (vfs.readdir(path).length && !options?.recursive) throw fsError('ENOTEMPTY', 'rmdir', path);
      vfs.rm(path);
    },
    unlinkSync(p: PathLike) {
      const path = resolve(p);
      if (vfs.isDirectory(path)) throw fsError('EISDIR', 'unlink', path);
      if (!vfs.isFile(path)) throw fsError('ENOENT', 'unlink', path);
      vfs.rm(path);
    },
    renameSync(a: PathLike, b: PathLike) {
      const from = resolve(a);
      const to = resolve(b);
      if (!vfs.exists(from)) throw fsError('ENOENT', 'rename', from, to);
      if (from === to) return;
      if (vfs.isDirectory(to) && vfs.isFile(from)) throw fsError('EISDIR', 'rename', from, to);
      requireParent(to, 'rename');
      if (vfs.isFile(to) && vfs.isDirectory(from)) throw fsError('ENOTDIR', 'rename', from, to);
      vfs.rm(to);
      copyTree(from, to);
      vfs.rm(from);
    },
    copyFileSync: copyFile,
    cpSync(src: PathLike, dest: PathLike, options?: { recursive?: boolean; force?: boolean }) {
      const from = resolve(src);
      if (vfs.isDirectory(from) && !options?.recursive) throw Object.assign(fsError('EISDIR', 'cp', from), { code: 'ERR_FS_EISDIR' });
      if (!vfs.exists(from)) throw fsError('ENOENT', 'cp', from);
      copyTree(from, resolve(dest));
    },
    realpathSync: Object.assign((p: PathLike) => {
      const path = resolve(p);
      if (!vfs.exists(path)) throw fsError('ENOENT', 'realpath', path);
      return path;
    }, { native: (p: PathLike) => api.realpathSync(p) }),
    readlinkSync: (p: PathLike) => {
      throw fsError('EINVAL', 'readlink', resolve(p));
    },
    /** No symlinks in the VFS: a link to a file becomes a copy of it. */
    symlinkSync(target: PathLike, p: PathLike) {
      const path = resolve(p);
      const from = typeof target === 'string' && !target.startsWith('/') ? join(dirname(path), target) : resolve(target);
      copyTree(from, path);
    },
    linkSync: (a: PathLike, b: PathLike) => copyFile(a, b),
    truncateSync(p: PathLike, length = 0) {
      const path = resolve(p);
      if (!vfs.isFile(path)) throw fsError('ENOENT', 'open', path);
      const bytes = bytesOf(path);
      const next = new Uint8Array(length);
      next.set(bytes.subarray(0, length));
      vfs.writeFile(path, next);
    },
    chmodSync: (p: PathLike) => void api.accessSync(p),
    lchmodSync: (p: PathLike) => void api.accessSync(p),
    chownSync: (p: PathLike) => void api.accessSync(p),
    lchownSync: (p: PathLike) => void api.accessSync(p),
    utimesSync: (p: PathLike) => void api.accessSync(p),
    lutimesSync: (p: PathLike) => void api.accessSync(p),
    fchmodSync: (fd: number) => void fileOf(fd, 'fchmod'),
    fchownSync: (fd: number) => void fileOf(fd, 'fchown'),
    futimesSync: (fd: number) => void fileOf(fd, 'futimes'),
    fsyncSync: (fd: number) => void fileOf(fd, 'fsync'),
    fdatasyncSync: (fd: number) => void fileOf(fd, 'fdatasync'),
    ftruncateSync: (fd: number, length = 0) => api.truncateSync(fileOf(fd, 'ftruncate').path, length),
    openSync: open,
    closeSync(fd: number) {
      if (fd > 2) fileOf(fd, 'close');
      fds.delete(fd);
    },
    readSync(fd: number, buffer: ArrayBufferView, offsetOrOptions?: number | { offset?: number; length?: number; position?: number | null }, length?: number, position?: number | null): number {
      const opts = typeof offsetOrOptions === 'object' ? offsetOrOptions : { offset: offsetOrOptions, length, position };
      const file = fileOf(fd, 'read');
      const bytes = bytesOf(file.path);
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const offset = opts.offset ?? 0;
      const from = opts.position ?? file.position;
      const chunk = bytes.subarray(from, from + Math.min(opts.length ?? target.length - offset, target.length - offset));
      target.set(chunk, offset);
      if (opts.position === undefined || opts.position === null) file.position = from + chunk.length;
      return chunk.length;
    },
    writeSync: writeFd,
    opendirSync(p: PathLike) {
      const path = resolve(p);
      const entries = api.readdirSync(path, { withFileTypes: true }) as Dirent[];
      let i = 0;
      return {
        path,
        readSync: () => entries[i++] ?? null,
        read: async () => entries[i++] ?? null,
        closeSync: () => undefined,
        close: async () => undefined,
        async *[Symbol.asyncIterator]() {
          while (i < entries.length) yield entries[i++]!;
        },
      };
    },
    /** For the stream and watch layers. */
    _resolve: resolve,
  };
  return api;
}

export type SyncFs = ReturnType<typeof createSyncFs>;
