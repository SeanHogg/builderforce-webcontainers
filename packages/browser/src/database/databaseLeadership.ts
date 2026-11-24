/**
 * Which tab owns a persistent project database. Two PGlite instances on the
 * same IndexedDB data would overwrite each other's files, so exactly one tab —
 * the holder of the runtime lease named after the database (runtimeLease.ts) —
 * runs it; the others proxy to it (databaseTabs.ts) and queue for the lease, so
 * when the owner closes the database or its tab dies, the next tab in line
 * takes over.
 *
 * Without `navigator.locks` a persistent database is refused with
 * `DatabaseCoordinationError` rather than risked. In-memory databases need no
 * coordination.
 */
import { claimRuntimeLease, type LockManagerLike } from '../shared/runtimeLease.js';

export { DatabaseCoordinationError, lockName } from '../shared/runtimeLease.js';
export type { LockManagerLike } from '../shared/runtimeLease.js';

/** This tab's place in the line for a database. */
export interface DatabaseOwnership {
  /** This tab owns the database now. */
  readonly owner: boolean;
  /** Called once, when this tab becomes the owner after waiting. */
  onOwner(listener: () => void): void;
  /** Give up ownership, or the place in line. */
  release(): void;
}

/** Take ownership of `key` if free, else join the line for it. */
export async function claimDatabase(locks: LockManagerLike | undefined, key: string): Promise<DatabaseOwnership> {
  const lease = await claimRuntimeLease(locks, `database:${key}`);
  return {
    get owner() {
      return lease.state.kind === 'owner';
    },
    onOwner: (listener) => lease.onOwner(listener),
    release: () => lease.release(),
  };
}
