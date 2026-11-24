/**
 * The ONE IndexedDB open/run helper for the runtime's single-store databases
 * (the model cache, the knowledge persistence). Defensive posture: when
 * IndexedDB is missing, fails to open, or is blocked, `openIdbStore` resolves
 * `undefined` and the caller degrades to a no-op store.
 *
 * Every request settles on its TRANSACTION, not the request: a write is only
 * durable once `tx.oncomplete` fires, and an abort after `req.onsuccess`
 * (quota, a constraint, a crash in a later request) must reject, not report
 * success. Reads run in 'readonly' transactions so they never serialize behind
 * writers.
 */

export interface IdbStoreConfig {
  dbName: string;
  storeName: string;
  /** Requested schema version. An existing database at a higher version is opened as-is. */
  version: number;
}

export interface IdbStore {
  /** Run one request in its own transaction; resolves with its result once the transaction commits. */
  run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>;
  /** Close the connection (tests, teardown). */
  close(): void;
}

/**
 * Open requests that were answered `undefined` because they were BLOCKED but are
 * still pending, per factory and database name. IndexedDB queues every later
 * open of that database behind a pending upgrade, so issuing another open while
 * one is blocked would hang until the blocker goes away; instead such opens
 * resolve `undefined` at once. The entry is cleared when the blocked request
 * finally settles (late success, closed immediately; or error), so the next
 * call retries.
 */
const blockedOpens = new WeakMap<IDBFactory, Set<string>>();

function isBlocked(factory: IDBFactory, name: string): boolean {
  return blockedOpens.get(factory)?.has(name) ?? false;
}

function markBlocked(factory: IDBFactory, name: string): void {
  let names = blockedOpens.get(factory);
  if (!names) {
    names = new Set();
    blockedOpens.set(factory, names);
  }
  names.add(name);
}

function clearBlocked(factory: IDBFactory, name: string): void {
  blockedOpens.get(factory)?.delete(name);
}

function openRaw(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  storeName: string,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    // A blocked open of this database is still pending: a new open would queue
    // behind it and hang, so answer `undefined` now and let the next call retry.
    if (isBlocked(factory, name)) {
      resolve(undefined);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = version === undefined ? factory.open(name) : factory.open(name, version);
    } catch {
      resolve(undefined);
      return;
    }
    // Set once we have answered `undefined` (blocked): the open request keeps going
    // and may still succeed later, and that late connection must not leak.
    let gaveUp = false;
    // Upgrade only ever ADDS the store when it is missing; existing data is never touched.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (gaveUp) {
        db.close();
        clearBlocked(factory, name);
        return;
      }
      // Never be the connection that blocks someone else's upgrade (another tab, a newer build).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (gaveUp) clearBlocked(factory, name);
      resolve(undefined);
    };
    request.onblocked = () => {
      if (!gaveUp) markBlocked(factory, name);
      gaveUp = true;
      resolve(undefined);
    };
  });
}

function storeOf(db: IDBDatabase, storeName: string, onClosed?: () => void): IdbStore {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
    onClosed?.();
  };
  // Another connection wants a newer version (or the browser closed us): release
  // the database and let the owner reopen on its next call.
  db.onversionchange = close;
  (db as IDBDatabase & { onclose: (() => void) | null }).onclose = close;
  return {
    run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        let req: IDBRequest<T> | undefined;
        try {
          tx = db.transaction(storeName, mode);
        } catch (error) {
          reject(error);
          return;
        }
        const failure = () => tx.error ?? req?.error ?? new Error(`IndexedDB transaction on ${storeName} failed`);
        tx.oncomplete = () => resolve(req!.result);
        tx.onabort = () => reject(failure());
        tx.onerror = () => reject(failure());
        try {
          req = fn(tx.objectStore(storeName));
        } catch (error) {
          // e.g. DataCloneError on put: nothing was queued, so abort and surface it.
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
          reject(error);
        }
      });
    },
    close,
  };
}

/**
 * Open `config.dbName` and make sure `config.storeName` exists. A database that
 * already exists at (or above) the requested version without the store is
 * reopened one version up so the store can be added; nothing existing is
 * dropped or migrated.
 */
export async function openIdbStore(
  factory: IDBFactory | undefined,
  config: IdbStoreConfig,
  onClosed?: () => void,
): Promise<IdbStore | undefined> {
  if (!factory) return undefined;
  let db = await openRaw(factory, config.dbName, config.version, config.storeName);
  if (!db) {
    // The database may already exist at a higher version than requested (VersionError):
    // open whatever version is there.
    db = await openRaw(factory, config.dbName, undefined, config.storeName);
    if (!db) return undefined;
  }
  if (!db.objectStoreNames.contains(config.storeName)) {
    const next = db.version + 1;
    db.close();
    db = await openRaw(factory, config.dbName, next, config.storeName);
    if (!db || !db.objectStoreNames.contains(config.storeName)) return undefined;
  }
  return storeOf(db, config.storeName, onClosed);
}

/**
 * A lazily opened, memoised store for one database — what every IndexedDB-backed
 * cache uses. Only a SUCCESSFUL open is memoised: a missing/blocked/failed open
 * yields `undefined` for that call and is retried on the next one, so one
 * transient block cannot turn the cache into a permanent no-op. When the
 * connection closes (versionchange, browser close, `close()`), the memo is
 * dropped and the next call reopens.
 */
export function lazyIdbStore(
  factory: IDBFactory | undefined,
  config: IdbStoreConfig,
): () => Promise<IdbStore | undefined> {
  let opened: Promise<IdbStore | undefined> | undefined;
  return () => {
    if (opened) return opened;
    const attempt: Promise<IdbStore | undefined> = openIdbStore(factory, config, () => {
      if (opened === attempt) opened = undefined;
    });
    opened = attempt;
    void attempt.then((store) => {
      if (!store && opened === attempt) opened = undefined;
    });
    return attempt;
  };
}

/** One request's result (for hand-built transactions; a write is durable only once its transaction is `done`). */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when `tx` commits; rejects when it errors or aborts. */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
