/**
 * Training artifacts (checkpoints, the output adapter's safetensors) in project
 * storage OUTSIDE the project's files, on the PAGE's origin: a Python program
 * writes them under {@link TRAINING_ARTIFACT_DIR} in Pyodide's file system
 * (never synced to the VFS); the worker streams them to the page
 * (trainingWorker.ts), and the page's sink (trainingSink.ts) commits each save
 * here. The worker never opens this store.
 *
 * Keyed by a host-owned project id plus the page-side identity of the process
 * (applicationId, serviceId) — never anything the process sets. A save
 * REPLACES the service's set in one IndexedDB transaction: the files and the
 * manifest last, so a reader sees a whole save or the previous one, never a
 * torn one; `list()` reads only the manifest. Built on the runtime's one
 * IndexedDB helper (shared/idb.ts). Without IndexedDB, saves fail and reads miss.
 */
import { lazyIdbStore } from '../../shared/idb.js';

export { TRAINING_ARTIFACT_DIR } from './trainingArtifactDir.js';

export interface TrainingArtifactKey {
  /** The host's project id (never the process's env). */
  projectId: string;
  /** The page-side identity of the training service. */
  applicationId: string;
  serviceId: string;
}

export interface TrainingArtifactStoreOptions {
  /** Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Default `bfwc-training-artifacts`. */
  name?: string;
}

export interface TrainingArtifactStore {
  /** Replace the service's artifacts with `files`, atomically. Rejects when storage is unavailable or the write fails. */
  replace(key: TrainingArtifactKey, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  read(key: TrainingArtifactKey, path: string): Promise<Uint8Array | undefined>;
  /** The committed save's paths (relative to the artifact directory), sorted. */
  list(key: TrainingArtifactKey): Promise<string[]>;
  /** Drop the service's artifacts. */
  remove(key: TrainingArtifactKey): Promise<void>;
}

const manifestKey = (key: TrainingArtifactKey): IDBValidKey => ['manifest', key.projectId, key.applicationId, key.serviceId];
const fileKey = (key: TrainingArtifactKey, path: string): IDBValidKey => ['file', key.projectId, key.applicationId, key.serviceId, path];

export function createTrainingArtifactStore(options: TrainingArtifactStoreOptions = {}): TrainingArtifactStore {
  const open = lazyIdbStore(options.indexedDB ?? globalThis.indexedDB, { dbName: options.name ?? 'bfwc-training-artifacts', storeName: 'artifacts', version: 1 });
  const required = async () => {
    const store = await open();
    if (!store) throw new Error('Training artifact storage (IndexedDB) is unavailable.');
    return store;
  };

  /** In one transaction: read the manifest, delete its files, then (when given) put the new files and manifest. */
  const rewrite = async (key: TrainingArtifactKey, files?: ReadonlyMap<string, Uint8Array>) => {
    const store = await required();
    await store.run('readwrite', (s) => {
      const previous = s.get(manifestKey(key));
      previous.onsuccess = () => {
        for (const path of (previous.result as string[] | undefined) ?? []) s.delete(fileKey(key, path));
        if (!files) return void s.delete(manifestKey(key));
        for (const [path, bytes] of files) s.put(bytes, fileKey(key, path));
        s.put([...files.keys()].sort(), manifestKey(key));
      };
      return previous;
    });
  };

  return {
    replace: (key, files) => rewrite(key, files),
    remove: (key) => rewrite(key),
    async read(key, path) {
      const store = await open();
      if (!store) return undefined;
      try {
        const paths = (await store.run<string[] | undefined>('readonly', (s) => s.get(manifestKey(key)))) ?? [];
        if (!paths.includes(path)) return undefined;
        return (await store.run<Uint8Array | undefined>('readonly', (s) => s.get(fileKey(key, path)))) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async list(key) {
      const store = await open();
      if (!store) return [];
      try {
        return [...((await store.run<string[] | undefined>('readonly', (s) => s.get(manifestKey(key)))) ?? [])];
      } catch {
        return [];
      }
    },
  };
}
