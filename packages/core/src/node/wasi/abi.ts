/**
 * WASI preview1's numbers and memory layout: errno values, file types, flags, and a
 * view over the module's memory that re-reads `memory.buffer` on every call (the
 * buffer is replaced whenever the module grows its memory).
 */

export const ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  EXIST: 20,
  FAULT: 21,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NAMETOOLONG: 37,
  NOENT: 44,
  NOSPC: 51,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  PERM: 63,
  SPIPE: 70,
  NOTCAPABLE: 76,
} as const;

export const FILETYPE = { UNKNOWN: 0, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 } as const;
export const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
export const FDFLAGS = { APPEND: 1 } as const;
export const WHENCE = { SET: 0, CUR: 1, END: 2 } as const;
export const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;

/** Every right: this runtime does not narrow capabilities per descriptor. */
export const ALL_RIGHTS = 0x1fffffffn;

/** A guest pointer or length outside the module's memory: answered as FAULT. */
export class Fault extends Error {}

/** Run guest-memory access, turning its RangeError into a `Fault` (an fs RangeError is not one). */
export function guest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw error instanceof RangeError ? new Fault(error.message) : error;
  }
}

/** Run a syscall body, answering a thrown error as its errno. */
export function attempt(fn: () => number | void): number {
  try {
    return fn() ?? ERRNO.SUCCESS;
  } catch (error) {
    return errnoOf(error);
  }
}

/** A number as the u64 WASI wants; NaN and infinities are 0. */
export const u64 = (n: number): bigint => (Number.isFinite(n) ? BigInt(Math.max(0, Math.round(n))) : 0n);

/** A Node error code (`ENOENT`) as a WASI errno. */
export function errnoOf(error: unknown): number {
  if (error instanceof Fault) return ERRNO.FAULT;
  if (error instanceof RangeError) return ERRNO.INVAL; // from fs work: a size or offset it cannot honor
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'ENOENT':
      return ERRNO.NOENT;
    case 'EEXIST':
      return ERRNO.EXIST;
    case 'EISDIR':
      return ERRNO.ISDIR;
    case 'ENOTDIR':
      return ERRNO.NOTDIR;
    case 'ENOTEMPTY':
      return ERRNO.NOTEMPTY;
    case 'EBADF':
      return ERRNO.BADF;
    case 'EINVAL':
      return ERRNO.INVAL;
    case 'EACCES':
      return ERRNO.ACCES;
    case 'EPERM':
      return ERRNO.PERM;
    case 'ENOSPC':
      return ERRNO.NOSPC;
    case 'ENAMETOOLONG':
      return ERRNO.NAMETOOLONG;
    case 'ELOOP':
      return ERRNO.LOOP;
    default:
      return ERRNO.IO;
  }
}

/** Little-endian access to the module's memory, current as of each call. */
export class Memory {
  constructor(private readonly memory: () => WebAssembly.Memory) {}

  get view(): DataView {
    return new DataView(this.memory().buffer);
  }

  bytes(at: number, length: number): Uint8Array {
    return guest(() => new Uint8Array(this.memory().buffer, at, length));
  }

  u32(at: number, value: number): void {
    guest(() => this.view.setUint32(at, value, true));
  }

  u64(at: number, value: bigint): void {
    guest(() => this.view.setBigUint64(at, value, true));
  }

  text(at: number, length: number): string {
    // a copy: TextDecoder rejects a view over a SharedArrayBuffer
    return new TextDecoder().decode(this.bytes(at, length).slice());
  }

  /** The buffers an `iovec` array points at (`fd_write`, `fd_read`). */
  iovecs(at: number, count: number): Uint8Array[] {
    return guest(() => {
      const view = this.view;
      const out: Uint8Array[] = [];
      for (let i = 0; i < count; i++) out.push(this.bytes(view.getUint32(at + i * 8, true), view.getUint32(at + i * 8 + 4, true)));
      return out;
    });
  }

  /** Write strings as WASI lays out argv/environ: a pointer table, then NUL-terminated bytes. */
  strings(values: readonly string[], pointers: number, buffer: number): void {
    guest(() => {
      const view = this.view;
      let at = buffer;
      values.forEach((value, i) => {
        const encoded = new TextEncoder().encode(value + '\0');
        view.setUint32(pointers + i * 4, at, true);
        this.bytes(at, encoded.length).set(encoded);
        at += encoded.length;
      });
    });
  }

  /** The sizes `args_sizes_get` / `environ_sizes_get` report. */
  sizes(values: readonly string[], countAt: number, bytesAt: number): void {
    this.u32(countAt, values.length);
    this.u32(bytesAt, values.reduce((total, value) => total + new TextEncoder().encode(value).length + 1, 0));
  }
}
