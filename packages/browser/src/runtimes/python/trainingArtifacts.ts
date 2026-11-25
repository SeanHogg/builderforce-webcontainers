/**
 * Training artifacts (checkpoints, the output adapter's safetensors) in project
 * storage OUTSIDE the project's files, on the PAGE's origin: a Python program
 * writes them under {@link TRAINING_ARTIFACT_DIR} in Pyodide's file system
 * (never synced to the VFS); the worker streams them to the page
 * (trainingControl.ts), and the page's sink (trainingSink.ts) commits each save
 * here. The worker never opens this store.
 *
 * Keyed by a STABLE page-side identity — the host's project id, the
 * application's spec `projectId` and the service id — so the next run of the
 * same application finds its last save (`applicationId` is not part
 * of the key). Nothing the process sets (its env) goes into a key: the Python
 * provider registers the key from the spec before it spawns. The spec's
 * `projectId` is therefore the boundary within a host project: any application
 * started from a spec with the same `projectId` and service id replaces that
 * set, so a host running specs it does not trust sets their `projectId` itself.
 *
 * A save REPLACES the service's set in one IndexedDB transaction: the files and
 * the manifest last, so a reader sees a whole save or the previous one, never a
 * torn one; `read()` takes the manifest and the file in one transaction, and
 * `list()` reads only the manifest. Built on the runtime's one IndexedDB helper
 * (shared/idb.ts). Without IndexedDB, saves fail and reads miss.
 */
import { lazyIdbStore } from '../../shared/idb.js';

export { TRAINING_ARTIFACT_DIR } from './trainingArtifactDir.js';

export interface TrainingArtifactKey {
  /** The host's project id (`PythonHostOptions.training.projectId`; never the process's env). */
  projectId: string;
  /** The application's spec `projectId`: stable across runs of the same application. */
  specProjectId: string;
  /** The training service's id in the spec. */
  serviceId: string;
}

/** The ONE string form of a key: per-service queues and grouping use it. */
export const artifactKeyId = (key: TrainingArtifactKey): string => JSON.stringify([key.projectId, key.specProjectId, key.serviceId]);

export interface TrainingArtifactStoreOptions {
  /** Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Default `bfwc-training-artifacts`. */
  name?: string;
}

export interface TrainingArtifactStore {
  /** Replace the service's artifacts with `files`, atomically. Rejects when storage is unavailable or the write fails. */
  replace(key: TrainingArtifactKey, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** One file of the committed save (the manifest and the file read in one transaction). */
  read(key: TrainingArtifactKey, path: string): Promise<Uint8Array | undefined>;
  /** The committed save's paths (relative to the artifact directory), sorted. */
  list(key: TrainingArtifactKey): Promise<string[]>;
  /** Drop the service's artifacts. */
  remove(key: TrainingArtifactKey): Promise<void>;
}

const manifestKey = (key: TrainingArtifactKey): IDBValidKey => ['manifest', key.projectId, key.specProjectId, key.serviceId];
const fileKey = (key: TrainingArtifactKey, path: string): IDBValidKey => ['file', key.projectId, key.specProjectId, key.serviceId, path];

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
        let bytes: Uint8Array | undefined;
        // The manifest and the file in ONE transaction: a save committing meanwhile is seen whole or not at all.
        await store.run('readonly', (s) => {
          const manifest = s.get(manifestKey(key));
          manifest.onsuccess = () => {
            if (!((manifest.result as string[] | undefined) ?? []).includes(path)) return;
            const file = s.get(fileKey(key, path));
            file.onsuccess = () => void (bytes = (file.result as Uint8Array | undefined) ?? undefined);
          };
          return manifest;
        });
        return bytes;
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
