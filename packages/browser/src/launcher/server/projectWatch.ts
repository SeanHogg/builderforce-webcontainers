/**
 * The project's changes, for `/__bf/changes`: ONE recursive `fs.watch` of the
 * project (with the tree's exclusions), debounced, each burst read back through
 * `readProjectChange` (the same caps and containment as `/__bf/files`) and handed
 * to every subscriber. The watch starts with the first subscriber and stops with
 * the last.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { ProjectChange } from '../protocol.js';
import { isExcludedPath, readProjectChange, toProjectPath, type ProjectLimits } from './projectFiles.js';

export interface ProjectWatchListener {
  changes(changes: ProjectChange[]): void;
  /** The watch failed (or reading a change did): reported, never swallowed. */
  error(message: string): void;
}

export interface ProjectWatch {
  subscribe(listener: ProjectWatchListener): () => void;
  close(): void;
}

export interface ProjectWatchOptions {
  debounceMs?: number;
  limits?: ProjectLimits;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Watch `root` (the project's real path). */
export function createProjectWatch(root: string, options: ProjectWatchOptions = {}): ProjectWatch {
  const debounceMs = options.debounceMs ?? 120;
  const listeners = new Set<ProjectWatchListener>();
  const pending = new Set<string>();
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const broadcastError = (message: string) => {
    for (const listener of [...listeners]) listener.error(message);
  };

  async function flush(): Promise<void> {
    timer = undefined;
    const paths = [...pending];
    pending.clear();
    const changes: ProjectChange[] = [];
    for (const path of paths) {
      try {
        const change = await readProjectChange(root, path, options.limits);
        if (change) changes.push(change);
      } catch (error) {
        broadcastError(`Reading ${path} failed: ${errorMessage(error)}`);
      }
    }
    if (changes.length === 0 || closed) return;
    for (const listener of [...listeners]) listener.changes(changes);
  }

  function start(): void {
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const path = toProjectPath(String(filename));
        if (!path || isExcludedPath(path)) return;
        pending.add(path);
        if (timer === undefined) timer = setTimeout(() => void flush(), debounceMs);
      });
      watcher.on('error', (error) => broadcastError(`Watching the project failed: ${errorMessage(error)}`));
    } catch (error) {
      watcher = undefined;
      broadcastError(`Watching the project failed: ${errorMessage(error)}`);
    }
  }

  function stop(): void {
    watcher?.close();
    watcher = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
  }

  return {
    subscribe(listener) {
      if (closed) {
        listener.error('The launcher has stopped.');
        return () => undefined;
      }
      listeners.add(listener);
      if (!watcher) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    close() {
      closed = true;
      listeners.clear();
      stop();
    },
  };
}
