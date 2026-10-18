/**
 * A directory of a {@link VirtualFileSystem}, seen as a whole file system:
 * `/src/App.tsx` in the view is `<root>/src/App.tsx` in the base. Reads, writes
 * and watch events pass straight through (the base stays the one store), and
 * nothing outside `root` is visible.
 *
 * This is how a project lives below the file-system root (`/home/project`)
 * while the dev server, builds, zips and the host's own file access keep
 * addressing it as `/`. Node programs see the base, so `process.cwd()` is a real
 * directory: tools that watch their project (chokidar under Vite) misbehave when
 * it is `/` itself.
 *
 * A subclass so it is accepted wherever a `VirtualFileSystem` is; every public
 * method is mapped (rootedFs.test.ts fails on one that is not).
 */
import { VirtualFileSystem, type DirectoryEntry, type FileContent, type FlatFiles, type FsChange } from './vfs.js';
import { normalizePath } from './paths.js';

class RootedFileSystem extends VirtualFileSystem {
  private readonly prefix: string;

  constructor(private readonly base: VirtualFileSystem, private readonly root: string) {
    super();
    this.prefix = root + '/';
  }

  /** View path → base path. */
  private real(path: string): string {
    const key = normalizePath(path);
    return key === '/' ? this.root : this.root + key;
  }

  /** Base path under `root` → view path. */
  private local(path: string): string {
    return path === this.root ? '/' : path.slice(this.root.length);
  }

  override writeFile(path: string, contents: FileContent): void {
    if (normalizePath(path) === '/') throw new Error(`EISDIR: illegal operation on a directory, open '/'`);
    this.base.writeFile(this.real(path), contents);
  }

  override readFile(path: string): FileContent | undefined {
    return this.base.readFile(this.real(path));
  }

  override isFile(path: string): boolean {
    return this.base.isFile(this.real(path));
  }

  override isDirectory(path: string): boolean {
    return normalizePath(path) === '/' || this.base.isDirectory(this.real(path));
  }

  override mkdir(path: string): void {
    if (normalizePath(path) !== '/') this.base.mkdir(this.real(path));
  }

  override readdir(path: string): string[] {
    return this.base.readdir(this.real(path));
  }

  override entries(path: string): DirectoryEntry[] {
    return this.base.entries(this.real(path));
  }

  override rename(from: string, to: string): void {
    this.base.rename(this.real(from), this.real(to));
  }

  override list(): string[] {
    return this.base.list().filter((path) => path.startsWith(this.prefix)).map((path) => this.local(path));
  }

  override explicitDirectories(): string[] {
    return this.base.explicitDirectories().filter((dir) => dir.startsWith(this.prefix)).map((dir) => this.local(dir));
  }

  override rm(path: string): void {
    this.base.rm(this.real(path));
  }

  override version(path: string): number | undefined {
    return this.base.version(this.real(path));
  }

  override mtime(path: string): number | undefined {
    return this.base.mtime(this.real(path));
  }

  override toFlat(): FlatFiles {
    const out: FlatFiles = {};
    for (const path of this.list()) out[path.slice(1)] = this.readFile(path)!;
    return out;
  }

  override watch(listener: (change: FsChange) => void, options: { under?: string } = {}): () => void {
    return this.base.watch((change) => {
      if (change.path !== this.root) listener({ ...change, path: this.local(change.path) });
    }, { under: this.real(options.under ?? '/') });
  }
}

/** `fs` seen from `root` (`/` is `fs` itself). */
export function rootedFileSystem(fs: VirtualFileSystem, root: string): VirtualFileSystem {
  const key = normalizePath(root);
  return key === '/' ? fs : new RootedFileSystem(fs, key);
}
