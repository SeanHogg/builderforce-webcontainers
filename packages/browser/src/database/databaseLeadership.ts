/**
 * Which tab owns a persistent project database. Two PGlite instances on the
 * same IndexedDB data would overwrite each other's files, so exactly one tab —
 * the holder of a Web Lock named after the database — runs it; the others
 * proxy to it (databaseTabs.ts) and queue for the lock, so when the owner
 * closes the database or its tab dies, the next tab in line takes over (the
 * browser releases a dead tab's lock).
 *
 * Web Locks are required for persistent databases. A BroadcastChannel claim
 * cannot rule out two owners (a tab that stops answering is indistinguishable
 * from one that is slow, and a frozen background tab cannot answer at all), so
 * without `navigator.locks` a persistent database is refused with
 * `DatabaseCoordinationError` rather than risked. In-memory databases need no
 * coordination.
 */

export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

/** This tab's place in the line for a database. */
export interface DatabaseOwnership {
  /** This tab owns the database now. */
  readonly owner: boolean;
  /** Called once, when this tab becomes the owner after waiting. */
  onOwner(listener: () => void): void;
  /** Give up ownership, or the place in line. */
  release(): void;
}

export class DatabaseCoordinationError extends Error {
  constructor(readonly database: string) {
    super(`The database "${database}" is persistent, and persistent databases need the Web Locks API (navigator.locks) to keep one tab in charge of them. This browser lacks it; use persistent: false here.`);
    this.name = 'DatabaseCoordinationError';
  }
}

export const lockName = (key: string) => `bfwc-database:${key}`;

/** Take ownership of `key` if free, else join the line for it. */
export async function claimDatabase(locks: LockManagerLike | undefined, key: string): Promise<DatabaseOwnership> {
  if (!locks) throw new DatabaseCoordinationError(key);
  const abort = new AbortController();
  let owner = false;
  let release: (() => void) | undefined;
  let released = false;
  let onOwner: (() => void) | undefined;
  /** Hold the lock until released: the callback's promise is the lock's lifetime. */
  const hold = (lock: unknown) => {
    if (!lock) return;
    if (released) return;
    owner = true;
    return new Promise<void>((resolve) => (release = resolve));
  };
  const immediately = await new Promise<boolean>((resolve, reject) => {
    locks
      .request(lockName(key), { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return hold(lock);
      })
      .catch(reject);
  });
  if (!immediately) {
    void locks
      .request(lockName(key), { signal: abort.signal }, (lock) => {
        const held = hold(lock);
        if (held) queueMicrotask(() => onOwner?.());
        return held;
      })
      .catch(() => undefined); // aborted: released before our turn
  }
  return {
    get owner() {
      return owner;
    },
    onOwner(listener) {
      onOwner = listener;
    },
    release() {
      released = true;
      owner = false;
      abort.abort();
      release?.();
    },
  };
}
