/**
 * A preview1 WASI host straight over a VirtualFileSystem — the one node:wasi
 * builds on (`createWasiModule`), with the files reached through the sync fs
 * (node/fs/sync.ts) instead of a process's `fs` module. For hosts that run a
 * module themselves (the browser package's Rust runtime).
 */
import type { VirtualFileSystem } from '../../vfs.js';
import { createSyncFs } from '../fs/sync.js';
import { Dirent } from '../fs/stats.js';
import type { WasiFs } from './files.js';
import { createWasiModule, type WasiHost, type WasiOptions } from './index.js';

export interface VfsWasiOptions extends Omit<WasiOptions, 'version'> {
  vfs: VirtualFileSystem;
  /** The module's working directory: relative paths the sync fs resolves. */
  cwd: string;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
}

export function createVfsWasi(options: VfsWasiOptions): WasiHost {
  const { vfs, cwd, stdout, stderr, ...wasi } = options;
  const toBytes = (chunk: string | Uint8Array) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  const sync = createSyncFs({ vfs, cwd: () => cwd, stdout: (chunk) => stdout(toBytes(chunk)), stderr: (chunk) => stderr(toBytes(chunk)) });
  const fs: WasiFs = {
    ...sync,
    // withFileTypes answers Dirents; the narrowing keeps the type honest without a cast.
    readdirSync: (path) => sync.readdirSync(path, { withFileTypes: true }).filter((entry): entry is Dirent => entry instanceof Dirent),
  };
  // `exit` is reached only without `returnOnExit`; a host driving the module itself answers exits from `start`.
  const { WASI } = createWasiModule({ fs, stdout, stderr, exit: () => undefined });
  return new WASI(wasi);
}
