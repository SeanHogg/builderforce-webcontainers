/**
 * The value types of the fs module: Node-shaped errors (`code`, `errno`,
 * `syscall`, `path` — callers branch on `code === 'ENOENT'`), `Stats`,
 * `Dirent` and `fs.constants`.
 */

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, 'no such file or directory'],
  EEXIST: [-17, 'file already exists'],
  EISDIR: [-21, 'illegal operation on a directory'],
  ENOTDIR: [-20, 'not a directory'],
  ENOTEMPTY: [-39, 'directory not empty'],
  EBADF: [-9, 'bad file descriptor'],
  EINVAL: [-22, 'invalid argument'],
  EPERM: [-1, 'operation not permitted'],
  EACCES: [-13, 'permission denied'],
  ENOSYS: [-38, 'function not implemented'],
};

export interface FsError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
  dest?: string;
}

export function fsError(code: keyof typeof ERRNO | string, syscall: string, path?: string, dest?: string): FsError {
  const [errno, text] = ERRNO[code] ?? [-1, code.toLowerCase()];
  const where = path === undefined ? '' : dest === undefined ? ` '${path}'` : ` '${path}' -> '${dest}'`;
  const error = new Error(`${code}: ${text}, ${syscall}${where}`) as FsError;
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

function inode(path: string): number {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) hash = ((hash * 33) ^ path.charCodeAt(i)) >>> 0;
  return hash;
}

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export class Stats {
  dev = 2049;
  ino: number;
  mode: number;
  nlink = 1;
  uid = 1000;
  gid = 1000;
  rdev = 0;
  size: number;
  blksize = 4096;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;

  constructor(path: string, kind: 'file' | 'directory', size: number, mtimeMs: number) {
    this.ino = inode(path);
    this.mode = kind === 'file' ? S_IFREG | 0o644 : S_IFDIR | 0o755;
    this.size = size;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = mtimeMs;
    this.atime = new Date(mtimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(mtimeMs);
    this.birthtime = new Date(mtimeMs);
  }

  isFile(): boolean { return (this.mode & 0o170000) === S_IFREG; }
  isDirectory(): boolean { return (this.mode & 0o170000) === S_IFDIR; }
  isSymbolicLink(): boolean { return false; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }
}

export class Dirent {
  constructor(readonly name: string, readonly parentPath: string, private readonly kind: 'file' | 'directory') {}
  get path(): string { return this.parentPath; }
  isFile(): boolean { return this.kind === 'file'; }
  isDirectory(): boolean { return this.kind === 'directory'; }
  isSymbolicLink(): boolean { return false; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }
}

export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024,
  O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_DSYNC: 4096, O_NONBLOCK: 2048,
  S_IFMT: 0o170000, S_IFREG, S_IFDIR, S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1,
};
