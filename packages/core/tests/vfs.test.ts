import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, type FsChange } from '../src/vfs.js';
import { normalizePath, dirname, extname, join } from '../src/paths.js';

describe('paths', () => {
  it('normalises dot segments, slashes and backslashes', () => {
    expect(normalizePath('src//./a/../b.ts')).toBe('/src/b.ts');
    expect(normalizePath('src\\x\\y.ts')).toBe('/src/x/y.ts');
    expect(normalizePath('../../a')).toBe('/a');
  });
  it('derives dirname, extname and join', () => {
    expect(dirname('/src/App.tsx')).toBe('/src');
    expect(dirname('/App.tsx')).toBe('/');
    expect(extname('/src/App.TSX')).toBe('.tsx');
    expect(extname('/.env')).toBe('');
    expect(join('/src', '../lib', 'x.ts')).toBe('/lib/x.ts');
  });
});

describe('VirtualFileSystem', () => {
  it('mounts the nested WebContainer tree and a flat map alike', () => {
    const fs = new VirtualFileSystem();
    fs.mount({ src: { directory: { 'main.tsx': { file: { contents: 'a' } } } } });
    fs.mount({ 'src/App.tsx': 'b', 'index.html': '<html></html>' });
    expect(fs.list()).toEqual(['/index.html', '/src/App.tsx', '/src/main.tsx']);
    expect(fs.readdir('/')).toEqual(['index.html', 'src']);
    expect(fs.isDirectory('/src')).toBe(true);
    expect(fs.toFlat()['src/main.tsx']).toBe('a');
  });

  it('decodes binary contents as text on request', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', new TextEncoder().encode('héllo'));
    expect(fs.readText('/a.txt')).toBe('héllo');
  });

  it('bumps versions per write and reports creation', () => {
    const fs = new VirtualFileSystem();
    const changes: FsChange[] = [];
    fs.watch((c) => changes.push(c));
    fs.writeFile('/a.ts', '1');
    const v1 = fs.version('/a.ts');
    fs.writeFile('/a.ts', '2');
    expect(fs.version('/a.ts')).toBeGreaterThan(v1!);
    expect(changes.map((c) => c.created)).toEqual([true, false]);
  });

  it('removes a directory recursively and emits each removal', () => {
    const fs = new VirtualFileSystem();
    fs.mount({ 'src/a.ts': '', 'src/deep/b.ts': '', 'srcx.ts': '' });
    const removed: string[] = [];
    fs.watch((c) => c.type === 'remove' && removed.push(c.path));
    fs.rm('/src');
    expect(fs.list()).toEqual(['/srcx.ts']);
    expect(removed.sort()).toEqual(['/src/a.ts', '/src/deep/b.ts']);
  });
});
