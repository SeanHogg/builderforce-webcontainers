/**
 * Opening PGlite inside the database Worker, and removing a persistent
 * database's storage. PGlite is imported at run time from an ES module URL
 * (a CDN by default, overridable), so neither the page nor the process Worker
 * bundle carries Postgres; its WebAssembly loads beside that module.
 */

/** The PGlite build this runtime is tested against. */
export const PGLITE_VERSION = '0.5.16';
export const DEFAULT_PGLITE_URL = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${PGLITE_VERSION}/dist/index.js`;

/** The slice of a PGlite instance the database Worker uses. */
export interface PGliteLike {
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
  dumpDataDir(compression?: 'auto' | 'gzip' | 'none'): Promise<Blob>;
  close(): Promise<void>;
}

export interface PGliteOpenOptions {
  /** `idb://<name>` or `memory://`. */
  dataDir: string;
  relaxedDurability?: boolean;
  /** A data directory to start from (an `export()`'s tarball). */
  loadDataDir?: Blob;
}

export type OpenPGlite = (options: PGliteOpenOptions) => Promise<PGliteLike>;

/** Open PGlite from the ES module at `url`. */
export function pgliteFrom(url: string = DEFAULT_PGLITE_URL): OpenPGlite {
  return async (options) => {
    const module = (await import(/* @vite-ignore */ url)) as { PGlite: { create(options: PGliteOpenOptions): Promise<PGliteLike> } };
    return module.PGlite.create(options);
  };
}

/** PGlite names a persistent data directory's IndexedDB database `/pglite/<name>`. */
export const indexedDbNameOf = (dataDir: string) => `/pglite/${dataDir.replace(/^idb:\/\//, '')}`;

/** Delete what a persistent database stored (nothing to do for `memory://`). */
export function deletePgliteStorage(dataDir: string, indexedDB: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!dataDir.startsWith('idb://') || !indexedDB) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(indexedDbNameOf(dataDir));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${dataDir}.`));
  });
}
