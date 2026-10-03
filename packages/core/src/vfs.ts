import { normalizePath, join } from './paths.js';

export type FileContent = string | Uint8Array;

/** The nested tree shape `@webcontainer/api`'s `mount()` takes — accepted as-is. */
export interface FileSystemTree {
  [name: string]: { file: { contents: FileContent } } | { directory: FileSystemTree };
}

/** A flat `{ 'src/main.tsx': '...' }` map, the other shape callers commonly hold. */
export type FlatFiles = Record<string, FileContent>;

export interface FsChange {
  type: 'write' | 'remove';
  path: string;
  /** For a write: the file did not exist before. A new file can change how imports resolve. */
  created?: boolean;
}

const decoder = new TextDecoder();

/**
 * An in-memory file system. Files only — a directory exists while it contains a
 * file, which keeps the store a single map and makes "is this a directory?" a
 * prefix check rather than a second structure to keep consistent.
 *
 * Every write bumps a per-file version, so a transform cache can key on
 * (path, version) instead of hashing contents.
 */
export class VirtualFileSystem {
  private readonly files = new Map<string, FileContent>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<(change: FsChange) => void>();
  private clock = 0;

  writeFile(path: string, contents: FileContent): void {
    const key = normalizePath(path);
    const created = !this.files.has(key);
    this.files.set(key, contents);
    this.versions.set(key, ++this.clock);
    this.emit({ type: 'write', path: key, created });
  }

  readFile(path: string): FileContent | undefined {
    return this.files.get(normalizePath(path));
  }

  readText(path: string): string | undefined {
    const contents = this.readFile(path);
    if (contents === undefined) return undefined;
    return typeof contents === 'string' ? contents : decoder.decode(contents);
  }

  isFile(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  isDirectory(path: string): boolean {
    const key = normalizePath(path);
    if (key === '/') return true;
    const prefix = key + '/';
    for (const file of this.files.keys()) if (file.startsWith(prefix)) return true;
    return false;
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isDirectory(path);
  }

  /** Direct children of a directory (files and sub-directories), sorted. */
  readdir(path: string): string[] {
    const key = normalizePath(path);
    const prefix = key === '/' ? '/' : key + '/';
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const name = rest.split('/')[0];
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  /** Every file path, sorted. */
  list(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Remove a file, or a directory and everything under it. */
  rm(path: string): void {
    const key = normalizePath(path);
    const prefix = key === '/' ? '/' : key + '/';
    for (const file of [...this.files.keys()]) {
      if (file === key || file.startsWith(prefix)) {
        this.files.delete(file);
        this.versions.delete(file);
        this.emit({ type: 'remove', path: file });
      }
    }
  }

  /** The file's version (bumped on every write), or undefined when absent. */
  version(path: string): number | undefined {
    return this.versions.get(normalizePath(path));
  }

  /**
   * Write many files at once. Takes either the nested WebContainer tree or a flat
   * path→contents map — or a mix, since each entry is judged on its own.
   */
  mount(files: FileSystemTree | FlatFiles, at = '/'): void {
    for (const [name, entry] of Object.entries(files)) {
      const path = join(at, name);
      if (typeof entry === 'string' || entry instanceof Uint8Array) this.writeFile(path, entry);
      else if ('file' in entry) this.writeFile(path, entry.file.contents);
      else this.mount(entry.directory, path);
    }
  }

  /** Flat snapshot keyed without the leading slash (`src/main.tsx`). */
  toFlat(): FlatFiles {
    const out: FlatFiles = {};
    for (const [path, contents] of this.files) out[path.slice(1)] = contents;
    return out;
  }

  watch(listener: (change: FsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: FsChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
