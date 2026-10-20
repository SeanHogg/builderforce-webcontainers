import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, type FsChange } from '../src/vfs.js';
import { baseToProject, projectToBase, rootedFileSystem } from '../src/rootedFs.js';

const ROOT = '/home/project';

function setup() {
  const base = new VirtualFileSystem();
  base.writeFile('/home/user/.npmrc', 'x');
  return { base, view: rootedFileSystem(base, ROOT) };
}

describe('rootedFileSystem', () => {
  it('is the file system itself at /', () => {
    const base = new VirtualFileSystem();
    expect(rootedFileSystem(base, '/')).toBe(base);
  });

  it('maps reads and writes onto the base below root', () => {
    const { base, view } = setup();
    view.writeTree({ 'package.json': '{}', src: { 'main.ts': 'a' } });
    expect(base.readText(`${ROOT}/src/main.ts`)).toBe('a');
    base.writeFile(`${ROOT}/index.html`, '<p>');
    expect(view.readText('/index.html')).toBe('<p>');
    expect(view.isFile('/package.json')).toBe(true);
    expect(view.exists('/src')).toBe(true);
    expect(view.readdir('/')).toEqual(['index.html', 'package.json', 'src']);
    expect(view.entries('/src')).toEqual([{ name: 'main.ts', kind: 'file' }]);
    expect(view.version('/src/main.ts')).toBe(base.version(`${ROOT}/src/main.ts`));
    expect(view.mtime('/src/main.ts')).toBe(base.mtime(`${ROOT}/src/main.ts`));
  });

  it('hides everything outside root and cannot escape it', () => {
    const { view } = setup();
    view.writeFile('/a.txt', '1');
    expect(view.list()).toEqual(['/a.txt']);
    expect(view.toFlat()).toEqual({ 'a.txt': '1' });
    expect(view.readFile('/../user/.npmrc')).toBeUndefined();
  });

  it('treats / as a directory even before the project has files', () => {
    const { view } = setup();
    expect(view.isDirectory('/')).toBe(true);
    expect(view.readdir('/')).toEqual([]);
    expect(() => view.writeFile('/', 'x')).toThrow(/EISDIR/);
  });

  it('maps mkdir, rename, rm and explicit directories', () => {
    const { base, view } = setup();
    view.mkdir('/empty');
    view.writeFile('/src/a.ts', 'a');
    view.rename('/src', '/lib');
    expect(base.isFile(`${ROOT}/lib/a.ts`)).toBe(true);
    expect(view.explicitDirectories()).toEqual(['/empty', '/lib']); // rename creates its target, as the base does
    view.rm('/');
    expect(view.list()).toEqual([]);
    expect(base.isFile('/home/user/.npmrc')).toBe(true);
  });

  it('reports changes below root in view paths, and only those', () => {
    const { base, view } = setup();
    const seen: FsChange[] = [];
    const scoped: string[] = [];
    view.watch((change) => seen.push(change));
    view.watch((change) => scoped.push(change.path), { under: '/src' });
    view.writeFile('/src/a.ts', 'a');
    base.writeFile('/tmp/b', 'b');
    base.writeFile(`${ROOT}/c.ts`, 'c');
    expect(seen.map((c) => [c.type, c.path])).toEqual([['write', '/src/a.ts'], ['write', '/c.ts']]);
    expect(scoped).toEqual(['/src/a.ts']);
  });

  it('maps every public method of VirtualFileSystem', () => {
    // Inherited ones are safe only when they are built purely on mapped methods.
    const composed = new Set(['constructor', 'readText', 'exists', 'writeTree']);
    const view = rootedFileSystem(new VirtualFileSystem(), ROOT);
    const own = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(view)));
    const unmapped = Object.getOwnPropertyNames(VirtualFileSystem.prototype)
      .filter((name) => !composed.has(name) && !own.has(name))
      .filter((name) => !['removeFile', 'link', 'ensureDir', 'unlink', 'unlinkDir', 'emit'].includes(name));
    expect(unmapped).toEqual([]);
  });
});

describe('project ↔ base paths', () => {
  it('maps a project path under root, never above it', () => {
    expect(projectToBase(ROOT, '/')).toBe(ROOT);
    expect(projectToBase(ROOT, 'packages/web')).toBe(`${ROOT}/packages/web`);
    expect(projectToBase(ROOT, '/../../etc')).toBe(`${ROOT}/etc`);
    expect(projectToBase('/', '/src')).toBe('/src');
  });

  it('maps a base path back, and nothing outside root', () => {
    expect(baseToProject(ROOT, ROOT)).toBe('/');
    expect(baseToProject(ROOT, `${ROOT}/src`)).toBe('/src');
    expect(baseToProject(ROOT, '/home/projects')).toBeUndefined();
    expect(baseToProject(ROOT, '/tmp')).toBeUndefined();
    expect(baseToProject('/', '/tmp')).toBe('/tmp');
  });
});
