/**
 * Live sync: each change the launcher streams (`/__bf/changes`) is written into
 * the runtime's file system (rooted at the project), or removed from it, so dev
 * servers and watchers inside the runtime see edits made on disk. A change the
 * server could not send (over a cap) is reported, never dropped silently.
 */
import type { ProjectChange } from '../protocol.js';
import { decodeBase64 } from './bootApplication.js';
import type { LaunchClient } from './launchConfig.js';

/** The slice of the runtime's file system live sync writes to. */
export interface SyncedFileSystem {
  writeFile(path: string, contents: string | Uint8Array): void;
  /**
   * Remove a file, or a directory and everything under it (the runtime's
   * `VirtualFileSystem.rm`): a directory deleted on disk arrives as ONE `deleted`
   * change for its path, so its files must go with it.
   */
  rm(path: string): void;
  exists(path: string): boolean;
}

export interface LiveSyncHandlers {
  /** A change could not be applied: over a cap, or the path is not a plain project path. */
  skipped(path: string): void;
  /** The stream stopped, or the server reported a watch failure. */
  error(message: string): void;
}

/** A project-relative path as a runtime path (`src/a.ts` → `/src/a.ts`); null for anything that is not a plain relative path. */
export function runtimePathOf(path: string): string | null {
  if (!path || path.startsWith('/') || path.includes('\\')) return null;
  const segments = path.split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ? null : `/${path}`;
}

/** Apply one change. Returns whether it changed the file system. */
export function applyChange(fs: SyncedFileSystem, change: ProjectChange, handlers: Pick<LiveSyncHandlers, 'skipped'>): boolean {
  const path = runtimePathOf(change.path);
  if (!path || change.skipped) {
    handlers.skipped(change.path);
    return false;
  }
  if (change.deleted) {
    if (!fs.exists(path)) return false;
    fs.rm(path);
    return true;
  }
  if (typeof change.content === 'string') fs.writeFile(path, change.content);
  else if (typeof change.base64 === 'string') fs.writeFile(path, decodeBase64(change.base64));
  else return false;
  return true;
}

/** Follow the change stream into `fs` until the returned stop is called. */
export function startLiveSync(client: LaunchClient, fs: SyncedFileSystem, handlers: LiveSyncHandlers): () => void {
  const abort = new AbortController();
  const change = (next: ProjectChange) => {
    try {
      applyChange(fs, next, handlers);
    } catch (error) {
      // One file that cannot be written must not end the stream: reported, and the next change still applies.
      handlers.error(`${next.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void client.followChanges({ change, error: handlers.error }, abort.signal);
  return () => abort.abort();
}
