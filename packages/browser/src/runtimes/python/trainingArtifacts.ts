/**
 * Training artifacts (checkpoints, the output adapter's safetensors) kept in
 * project storage OUTSIDE the project's files: a Python program writes them
 * under {@link TRAINING_ARTIFACT_DIR} in Pyodide's file system (never synced
 * to the VFS), and the worker copies them into IndexedDB, keyed by project,
 * service and path, through the runtime's one IndexedDB helper (shared/idb.ts).
 * The host reads them back with the same store. Fails soft: without IndexedDB
 * nothing is kept and reads miss.
 */
import { lazyIdbStore } from '../../shared/idb.js';
import type { EmscriptenFs } from './pyodideLoader.js';

/** Where a Python program writes artifacts (`bfwc.training.artifact_dir()`); outside `/project`. */
export const TRAINING_ARTIFACT_DIR = '/bfwc-artifacts';

export interface TrainingArtifactStoreOptions {
  /** Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Default `bfwc-training-artifacts`. */
  name?: string;
}

export interface TrainingArtifactStore {
  /** False when it was not kept (storage unavailable). */
  write(projectId: string, serviceId: string, path: string, data: Uint8Array): Promise<boolean>;
  read(projectId: string, serviceId: string, path: string): Promise<Uint8Array | undefined>;
  /** The service's artifact paths (relative to the artifact directory), sorted. */
  list(projectId: string, serviceId: string): Promise<string[]>;
}

const prefixOf = (projectId: string, serviceId: string) => `${encodeURIComponent(projectId)}/${encodeURIComponent(serviceId)}/`;

export function createTrainingArtifactStore(options: TrainingArtifactStoreOptions = {}): TrainingArtifactStore {
  const open = lazyIdbStore(options.indexedDB ?? globalThis.indexedDB, { dbName: options.name ?? 'bfwc-training-artifacts', storeName: 'artifacts', version: 1 });
  return {
    async write(projectId, serviceId, path, data) {
      const store = await open();
      if (!store) return false;
      try {
        await store.run('readwrite', (s) => s.put(data, prefixOf(projectId, serviceId) + path));
        return true;
      } catch {
        return false;
      }
    },
    async read(projectId, serviceId, path) {
      const store = await open();
      if (!store) return undefined;
      try {
        return (await store.run<Uint8Array | undefined>('readonly', (s) => s.get(prefixOf(projectId, serviceId) + path))) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async list(projectId, serviceId) {
      const store = await open();
      if (!store) return [];
      const prefix = prefixOf(projectId, serviceId);
      try {
        const keys = await store.run('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
        return keys.map((key) => String(key).slice(prefix.length)).sort();
      } catch {
        return [];
      }
    },
  };
}

/** Every file under the artifact directory in `FS`, as [relative path, bytes]. */
export function artifactFiles(FS: EmscriptenFs, dir = TRAINING_ARTIFACT_DIR): Array<[string, Uint8Array]> {
  if (!FS.analyzePath(dir).exists) return [];
  const files: Array<[string, Uint8Array]> = [];
  const walk = (path: string, relative: string) => {
    for (const name of FS.readdir(path)) {
      if (name === '.' || name === '..') continue;
      const full = `${path}/${name}`;
      const rel = relative ? `${relative}/${name}` : name;
      if (FS.isDir(FS.stat(full).mode)) walk(full, rel);
      else files.push([rel, FS.readFile(full)]);
    }
  };
  walk(dir, '');
  return files;
}
