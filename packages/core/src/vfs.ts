import { normalizePath, join, dirname } from './paths.js';

export type FileContent = string | Uint8Array;

/** The nested tree shape `@webcontainer/api`'s `mount()` takes — accepted as-is. */
export interface FileSystemTree {
  [name: string]: { file: { contents: FileContent } } | { directory: FileSystemTree };
}

/** A flat `{ 'src/main.tsx': '...' }` map, the other shape callers commonly hold. */
export type FlatFiles = Record<string, FileContent>;

export interface FsChange {
  /** `mkdir` is an explicitly created (possibly empty) directory. */
  type: 'write' | 'remove' | 'mkdir';
  path: string;
  /** For a write: the file did not exist before. A new file can change how imports resolve. */
  created?: boolean;
}

const decoder = new TextDecoder();

/**
 * An in-memory file system. Files are the store; a directory exists while it
 * contains something, or because it was created explicitly with `mkdir` (shells
 * and Node programs create empty directories, a preview never needs to).
 *
 * A directory index (dir → child names) is maintained alongside the files, so
 * `isDirectory`/`readdir` stay O(1)/O(children) even with a populated
 * `node_modules` of tens of thousands of files — module resolution probes those
 * constantly.
 *
 * Every write bumps a per-file version, so a transform cache can key on
 * (path, version) instead of hashing contents.
 */
export class VirtualFileSystem {
  private readonly files = new Map<string, FileContent>();
  private readonly versions = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();
  /** dir → names of its direct children (files and directories). */
  private readonly children = new Map<string, Set<string>>([['/', new Set()]]);
  /** Directories created with `mkdir`: they outlive their last file. */
  private readonly explicit = new Set<string>();
  private readonly listeners = new Set<(change: FsChange) => void>();
  private clock = 0;

  writeFile(path: string, contents: FileContent): void {
    const key = normalizePath(path);
    if (key === '/' || this.children.has(key)) throw new Error(`EISDIR: illegal operation on a directory, open '${key}'`);
    const created = !this.files.has(key);
    if (created) this.link(key);
    this.files.set(key, contents);
    this.versions.set(key, ++this.clock);
    this.mtimes.set(key, Date.now());
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
    return this.children.has(normalizePath(path));
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isDirectory(path);
  }

  /** Create a directory (and its parents). A no-op when it already exists. */
  mkdir(path: string): void {
    const key = normalizePath(path);
    if (this.files.has(key)) throw new Error(`EEXIST: file already exists, mkdir '${key}'`);
    if (key === '/') return;
    const existed = this.children.has(key);
    this.explicit.add(key);
    if (existed) return;
    this.ensureDir(key);
    this.emit({ type: 'mkdir', path: key });
  }

  /** Direct children of a directory (files and sub-directories), sorted. */
  readdir(path: string): string[] {
    return [...(this.children.get(normalizePath(path)) ?? [])].sort();
  }

  /** Every file path, sorted. */
  list(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Directories created explicitly with `mkdir` — what `list()` cannot reproduce. */
  explicitDirectories(): string[] {
    return [...this.explicit].sort();
  }

  /** Remove a file, or a directory and everything under it. */
  rm(path: string): void {
    const key = normalizePath(path);
    if (this.files.has(key)) {
      this.removeFile(key);
      return;
    }
    if (!this.children.has(key)) return;
    for (const name of [...(this.children.get(key) ?? [])]) this.rm(key === '/' ? '/' + name : `${key}/${name}`);
    if (key === '/') return;
    const wasExplicit = this.explicit.delete(key);
    if (this.children.has(key)) this.unlinkDir(key);
    if (wasExplicit) this.emit({ type: 'remove', path: key });
  }

  /** The file's version (bumped on every write), or undefined when absent. */
  version(path: string): number | undefined {
    return this.versions.get(normalizePath(path));
  }

  /** When the file was last written (epoch ms), or undefined when absent. */
  mtime(path: string): number | undefined {
    return this.mtimes.get(normalizePath(path));
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
      else {
        this.mkdir(path);
        this.mount(entry.directory, path);
      }
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

  private removeFile(key: string): void {
    this.files.delete(key);
    this.versions.delete(key);
    this.mtimes.delete(key);
    this.unlink(key);
    this.emit({ type: 'remove', path: key });
  }

  /** Register `key` under its parent, creating implicit ancestors as needed. */
  private link(key: string): void {
    const parent = dirname(key);
    this.ensureDir(parent);
    this.children.get(parent)!.add(key.slice(key.lastIndexOf('/') + 1));
  }

  private ensureDir(dir: string): void {
    if (this.children.has(dir)) return;
    if (this.files.has(dir)) throw new Error(`ENOTDIR: not a directory, '${dir}'`);
    this.children.set(dir, new Set());
    this.link(dir);
  }

  /** Detach `key` from its parent, pruning implicit ancestors left empty. */
  private unlink(key: string): void {
    const parent = dirname(key);
    const siblings = this.children.get(parent);
    if (!siblings) return;
    siblings.delete(key.slice(key.lastIndexOf('/') + 1));
    if (siblings.size === 0 && parent !== '/' && !this.explicit.has(parent)) this.unlinkDir(parent);
  }

  private unlinkDir(dir: string): void {
    this.children.delete(dir);
    this.unlink(dir);
  }

  private emit(change: FsChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
