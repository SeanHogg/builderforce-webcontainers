/**
 * Which tab owns a piece of persistent runtime state (a project database, a
 * recoverable environment). Two tabs writing the same IndexedDB data would
 * overwrite each other, so exactly one tab — the holder of a Web Lock named
 * after the state — owns it; the others queue for the lock, so when the owner
 * releases it or its tab dies, the next tab in line takes over (the browser
 * releases a dead tab's lock).
 *
 * Every acquisition advances a fencing token kept in IndexedDB, so it outlives
 * the page: a holder that lost the lease (released, or its tab was frozen while
 * the next one took over) still carries its old token, and `assertFence` fails
 * for it. Writers check the fence before writing.
 *
 * Web Locks are required. A BroadcastChannel claim cannot rule out two owners
 * (a tab that stops answering is indistinguishable from one that is slow, and a
 * frozen background tab cannot answer at all), so without `navigator.locks` a
 * lease is refused with `DatabaseCoordinationError` rather than risked.
 */
import { newTabId } from '../database/databaseTabs.js';
import { lazyIdbStore } from './idb.js';

export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

/** The last acquisition of a lease, as kept in IndexedDB. */
export interface RuntimeLeaseRecord {
  formatVersion: 1;
  runtimeId: string;
  fencingToken: number;
  /** The tab that acquired it. */
  holder: string;
  /** `Date.now()` at the acquisition. */
  updatedAt: number;
}

export type LeaseState = { kind: 'owner'; fencingToken: number } | { kind: 'owned-elsewhere' };

/** This tab's place in the line for a lease. */
export interface RuntimeLease {
  readonly state: LeaseState;
  /** Called once, when this tab becomes the owner after waiting. */
  onOwner(listener: () => void): void;
  /** Give up ownership, or the place in line. */
  release(): void;
  /** Whether `token` is this tab's current fencing token: false for a stale holder or a released lease. */
  assertFence(token: number): boolean;
}

/** Where fencing tokens are kept. Only the lock holder calls `advance`, so a read-then-write cannot race. */
export interface LeaseTokenStore {
  /** Record an acquisition of `runtimeId` by `holder`: the stored token plus one. */
  advance(runtimeId: string, holder: string): Promise<RuntimeLeaseRecord>;
}

export class DatabaseCoordinationError extends Error {
  constructor(readonly database: string) {
    super(`"${database}" is persistent, and persistent databases and runtimes need the Web Locks API (navigator.locks) to keep one tab in charge of them. This browser lacks it; use persistent: false here.`);
    this.name = 'DatabaseCoordinationError';
  }
}

export const LOCK_PREFIX = 'bfwc-';
export const lockName = (key: string, prefix = LOCK_PREFIX) => `${prefix}${key}`;

const LEASE_DB = { dbName: 'bfwc-runtime-leases', storeName: 'leases', version: 1 };
const OWNED_ELSEWHERE: LeaseState = { kind: 'owned-elsewhere' };

/** Fencing tokens in IndexedDB (`bfwc-runtime-leases`), so they survive a reload or a dead tab. */
export function indexedDbLeaseTokenStore(factory: IDBFactory | undefined = globalThis.indexedDB): LeaseTokenStore {
  const open = lazyIdbStore(factory, LEASE_DB);
  return {
    async advance(runtimeId, holder) {
      const store = await open();
      if (!store) throw new Error(`The fencing token of "${runtimeId}" cannot be kept: IndexedDB is unavailable or blocked.`);
      const last = await store.run('readonly', (leases) => leases.get(runtimeId) as IDBRequest<RuntimeLeaseRecord | undefined>);
      const record: RuntimeLeaseRecord = { formatVersion: 1, runtimeId, fencingToken: (last?.fencingToken ?? 0) + 1, holder, updatedAt: Date.now() };
      await store.run('readwrite', (leases) => leases.put(record, runtimeId));
      return record;
    },
  };
}

let sharedTokenStore: LeaseTokenStore | undefined;
const defaultTokenStore = () => (sharedTokenStore ??= indexedDbLeaseTokenStore());

/** Take the lease on `key` if free (advancing its fencing token), else join the line for it. */
export async function claimRuntimeLease(locks: LockManagerLike | undefined, key: string, store: LeaseTokenStore = defaultTokenStore()): Promise<RuntimeLease> {
  if (!locks) throw new DatabaseCoordinationError(key);
  const holder = newTabId();
  const abort = new AbortController();
  let state = OWNED_ELSEWHERE;
  let release: (() => void) | undefined;
  let released = false;
  let onOwner: (() => void) | undefined;
  /** Advance the token for a granted lock; false when there is none to take (not granted, or released meanwhile). */
  const take = async (lock: unknown): Promise<boolean> => {
    if (!lock || released) return false;
    const { fencingToken } = await store.advance(key, holder);
    if (released) return false;
    state = { kind: 'owner', fencingToken };
    return true;
  };
  /** Hold the lock until released: the callback's promise is the lock's lifetime. */
  const hold = () => new Promise<void>((resolve) => (release = resolve));
  const immediately = await new Promise<boolean>((resolve, reject) => {
    locks
      .request(lockName(key), { ifAvailable: true }, async (lock) => {
        const owner = await take(lock);
        resolve(owner);
        if (owner) await hold();
      })
      .catch(reject);
  });
  if (!immediately) {
    void locks
      .request(lockName(key), { signal: abort.signal }, async (lock) => {
        if (!(await take(lock))) return;
        queueMicrotask(() => onOwner?.());
        await hold();
      })
      .catch((error: unknown) => {
        // Aborted: released before our turn. Anything else (the token could not be
        // advanced) gave the lock up to the next in line; this tab stays a follower.
        if (!abort.signal.aborted) console.error(`[bfwc] Could not take the lease on "${key}":`, error);
      });
  }
  return {
    get state() {
      return state;
    },
    onOwner(listener) {
      onOwner = listener;
    },
    release() {
      released = true;
      state = OWNED_ELSEWHERE;
      abort.abort();
      release?.();
    },
    assertFence: (token) => state.kind === 'owner' && state.fencingToken === token,
  };
}
