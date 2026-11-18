import { normalizePath, join, dirname } from './paths.js';

export type FileContent = string | Uint8Array;

/** A flat `{ 'src/main.tsx': '...' }` map: path → contents. */
export type FlatFiles = Record<string, FileContent>;

/**
 * Files to write: a name maps to contents (a file) or to another tree (a
 * directory). Names may hold slashes, so a {@link FlatFiles} map is a tree too,
 * and the two styles mix freely: `{ src: { 'main.tsx': '…' }, 'public/a.svg': '…' }`.
 */
export interface FileTree {
  [name: string]: FileContent | FileTree;
}

export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface FsChange {
  /** `mkdir` is an explicitly created (possibly empty) directory. */
  type: 'write' | 'remove' | 'mkdir';
  path: string;
  /** For a write: the file did not exist before. A new file can change how imports resolve. */
  created?: boolean;
  /**
   * For a mkdir: the directory already existed because it held files, and is now
   * explicit (it outlives its last file). Only watchers that ask for `promotions`
   * see these; to everyone else `mkdir` of an existing directory is silent.
   */
  promoted?: boolean;
}

/** Options for {@link VirtualFileSystem.watch}. */
export interface WatchOptions {
  /** Only changes at or below this path. */
  under?: string;
  /** Also report an existing directory made explicit by `mkdir` (`promoted: true`). For mirrors that must replay every state change. */
  promotions?: boolean;
}

/** A file's contents, or a function returning them on first read (a snapshot not yet copied out). */
export type SeedContent = FileContent | (() => FileContent);

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
 *
 * Files loaded with `seed` may hold their contents behind a function, called on
 * the first read and replaced by its result (copy-on-read): a process starts
 * from a snapshot without copying the files it never opens.
 */
export class VirtualFileSystem {
  private readonly files = new Map<string, SeedContent>();
  private readonly versions = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();
  /** dir → names of its direct children (files and directories). */
  private readonly children = new Map<string, Set<string>>([['/', new Set()]]);
  /** Directories created with `mkdir`: they outlive their last file. */
  private readonly explicit = new Set<string>();
  /** Listener → whether it wants directory promotions too. */
  private readonly listeners = new Map<(change: FsChange) => void, boolean>();
  private clock = 0;

  /** A stored file's contents, copying a seeded file out of its snapshot on first read. (A property, not a method: subclasses map methods only.) */
  private readonly content = (key: string): FileContent | undefined => {
    const stored = this.files.get(key);
    if (typeof stored !== 'function') return stored;
    const contents = stored();
    this.files.set(key, contents);
    return contents;
  };

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
    return this.content(normalizePath(path));
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
    const promoted = existed && !this.explicit.has(key);
    this.explicit.add(key);
    if (existed) {
      if (promoted) for (const [listener, promotions] of this.listeners) if (promotions) listener({ type: 'mkdir', path: key, promoted: true });
      return;
    }
    this.ensureDir(key);
    this.emit({ type: 'mkdir', path: key });
  }

  /**
   * Load a snapshot without change events: explicit directories, then files. A
   * function is a file's contents, called on its first read (copy-on-read).
   * Paths are absolute; an existing file at a path is replaced.
   */
  seed(files: Iterable<readonly [string, SeedContent]>, dirs: Iterable<string> = []): void {
    for (const dir of dirs) {
      const key = normalizePath(dir);
      if (key === '/') continue;
      if (this.files.has(key)) throw new Error(`EEXIST: file already exists, mkdir '${key}'`);
      this.explicit.add(key);
      this.ensureDir(key);
    }
    const now = Date.now();
    for (const [path, contents] of files) {
      const key = normalizePath(path);
      if (key === '/' || this.children.has(key)) throw new Error(`EISDIR: illegal operation on a directory, open '${key}'`);
      if (!this.files.has(key)) this.link(key);
      this.files.set(key, contents);
      this.versions.set(key, ++this.clock);
      this.mtimes.set(key, now);
    }
  }

  /** Direct children of a directory (files and sub-directories), sorted. */
  readdir(path: string): string[] {
    return [...(this.children.get(normalizePath(path)) ?? [])].sort();
  }

  /** Direct children with their kind, sorted by name — `readdir` for callers that render a tree. */
  entries(path: string): DirectoryEntry[] {
    const dir = normalizePath(path);
    return this.readdir(dir).map((name) => ({ name, kind: this.children.has(join(dir, name)) ? 'directory' : 'file' }));
  }

  /**
   * Move a file or a directory (with everything under it). Throws when `from` is
   * missing or `to` already exists. Watchers see the old paths removed and the
   * new ones written, which is what every consumer (dev server, process sync) needs.
   */
  rename(from: string, to: string): void {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === target) return;
    if (!this.exists(source)) throw new Error(`ENOENT: no such file or directory, rename '${source}' -> '${target}'`);
    if (this.exists(target)) throw new Error(`EEXIST: file already exists, rename '${source}' -> '${target}'`);
    if (target.startsWith(source + '/')) throw new Error(`EINVAL: cannot move '${source}' into itself`);
    if (this.files.has(source)) {
      const contents = this.content(source)!;
      this.removeFile(source);
      this.writeFile(target, contents);
      return;
    }
    const prefix = source + '/';
    const moved = [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => [path, this.content(path)!] as const);
    const dirs = [...this.explicit].filter((dir) => dir === source || dir.startsWith(prefix));
    this.rm(source);
    this.mkdir(target);
    for (const dir of dirs) this.mkdir(target + dir.slice(source.length));
    for (const [path, contents] of moved) this.writeFile(target + path.slice(source.length), contents);
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

  /** Write many files at once, under `at` (default `/`). A nested object is a directory, created even when empty. */
  writeTree(files: FileTree, at = '/'): void {
    for (const [name, entry] of Object.entries(files)) {
      const path = join(at, name);
      if (typeof entry === 'string' || entry instanceof Uint8Array) this.writeFile(path, entry);
      else {
        this.mkdir(path);
        this.writeTree(entry, path);
      }
    }
  }

  /** Flat snapshot keyed without the leading slash (`src/main.tsx`). */
  toFlat(): FlatFiles {
    const out: FlatFiles = {};
    for (const path of this.files.keys()) out[path.slice(1)] = this.content(path)!;
    return out;
  }

  /** Every change, or with `under` only changes at or below that path. */
  watch(listener: (change: FsChange) => void, options: WatchOptions = {}): () => void {
    const root = options.under === undefined ? undefined : normalizePath(options.under);
    const filtered = root === undefined || root === '/'
      ? listener
      : (change: FsChange) => (change.path === root || change.path.startsWith(root + '/')) && listener(change);
    this.listeners.set(filtered, !!options.promotions);
    return () => this.listeners.delete(filtered);
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
    for (const listener of this.listeners.keys()) listener(change);
  }
}
