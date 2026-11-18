/**
 * Shared fixtures for database tests: an in-thread database Worker running the
 * real PGlite (npm build, IndexedDB from fake-indexeddb), a test runtime that
 * hosts both processes and databases, a Web Locks stand-in shared by simulated
 * tabs, and npm packages (`pg`,
 * `drizzle-orm`) copied unmodified from this repo's node_modules into a
 * project's VFS (offline and deterministic — the files `npm install` writes).
 */
import 'fake-indexeddb/auto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerLike } from '../src/node/processHost.js';
import { createDatabaseWorker } from '../src/database/databaseWorker.js';
import { deletePgliteStorage, type OpenPGlite, type PGliteLike } from '../src/database/pgliteLoader.js';
import type { ToDatabase } from '../src/database/databaseProtocol.js';
import type { LockManagerLike } from '../src/database/databaseLeadership.js';
import type { DatabaseServiceHost } from '../src/app/pgliteProvider.js';
import { host } from './helpers.js';

export { collect } from './helpers.js';

const openPGlite: OpenPGlite = async (options) => {
  const { PGlite } = await import('@electric-sql/pglite');
  return (await PGlite.create(options)) as unknown as PGliteLike;
};

/** A database Worker in this thread, with structured-clone messaging like the real thing. */
export function fakeDatabaseWorker(): WorkerLike {
  let alive = true;
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const copy = structuredClone(message) as ToDatabase;
      queueMicrotask(() => alive && database.receive(copy));
    },
    terminate() {
      alive = false;
    },
  };
  const database = createDatabaseWorker({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => alive && worker.onmessage?.({ data: copy }));
    },
    openPGlite: () => openPGlite,
    deleteStorage: (dataDir) => deletePgliteStorage(dataDir),
  });
  return worker;
}

/** A runtime of process Workers plus what the pglite provider needs from it (`createWorker`: see `host`). */
export function appHost(files: Record<string, string> = {}, createWorker?: Parameters<typeof host>[2], kinds?: Parameters<typeof host>[3]) {
  const runtime = host(files, 2000, createWorker, kinds);
  const databases: DatabaseServiceHost = {
    listenTcp: (port, accept) => runtime.processes.ports.listen(port, async () => ({ status: 502, headers: {}, body: new ReadableStream() }), undefined, accept),
    createDatabaseWorker: fakeDatabaseWorker,
  };
  return { ...runtime, databases };
}

/** Web Locks for simulated tabs: exclusive, `ifAvailable`, queued waiters, abortable. */
export function fakeLocks(): LockManagerLike {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const grant = async (name: string, callback: (lock: unknown) => Promise<void> | void) => {
    held.add(name);
    try {
      return await callback({ name });
    } finally {
      held.delete(name);
      waiting.get(name)?.shift()?.();
    }
  };
  return {
    async request(name, options, callback) {
      if (!held.has(name)) return grant(name, callback);
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const queue = waiting.get(name) ?? [];
        waiting.set(name, queue);
        queue.push(resolve);
        options.signal?.addEventListener('abort', () => {
          queue.splice(queue.indexOf(resolve), 1);
          reject(new Error('Aborted.'));
        });
      });
      return grant(name, callback);
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));

/** Where Node would find package `name` from `fromDir` (walking up `node_modules`), symlinks resolved. */
function packageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`Cannot find package ${name} from ${fromDir}`);
  }
}

function addFiles(dir: string, at: string, files: Record<string, string>, include: RegExp): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) addFiles(path, `${at}/${entry}`, files, include);
    else if (include.test(entry)) files[`${at}/${entry}`] = readFileSync(path, 'utf8');
  }
}

/**
 * `node_modules/<name>/…` for a package and its dependencies, flattened, as a
 * VFS tree. `include` picks the files copied (default: scripts and JSON).
 */
export function installedPackage(name: string, options: { root?: string; include?: RegExp } = {}, fromDir = join(here, '..'), files: Record<string, string> = {}): Record<string, string> {
  const root = options.root ?? 'node_modules';
  if (Object.keys(files).some((path) => path.startsWith(`${root}/${name}/`))) return files;
  const dir = packageDir(name, fromDir);
  addFiles(dir, `${root}/${name}`, files, options.include ?? /\.(c?js|mjs|json)$/);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) installedPackage(dependency, { root }, dir, files);
  return files;
}
