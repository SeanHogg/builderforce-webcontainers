import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '../../src/vfs.js';
import { packFileSystem, readPack } from '../../src/vfs/pack.js';
import { mountSnapshot } from '../../src/vfs/snapshots.js';

/** Everything a mirror must reproduce: files with contents, and explicit directories. */
function state(fs: VirtualFileSystem) {
  return { files: fs.list().map((path) => [path, fs.readFile(path)]), dirs: fs.explicitDirectories() };
}

function mounted(buffer: ArrayBuffer): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  mountSnapshot(fs, { pack: buffer, ops: [] });
  return fs;
}

describe('file-system pack', () => {
  it('round-trips text, bytes, explicit directories and the sequence', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'package.json': '{"name":"x"}', src: { 'main.ts': 'export const a = 1;\n', 'logo.png': new Uint8Array([137, 80, 78, 71, 0, 255]) } });
    fs.mkdir('/empty/nested');
    fs.mkdir('/src'); // implicit → explicit
    const pack = packFileSystem(fs, 42);
    expect(readPack(pack).seq).toBe(42);
    const copy = mounted(pack);
    expect(state(copy)).toEqual(state(fs));
    expect(copy.readFile('/src/logo.png')).toBeInstanceOf(Uint8Array);
    expect(copy.isDirectory('/empty/nested')).toBe(true);
    copy.rm('/src/main.ts');
    copy.rm('/src/logo.png');
    expect(copy.isDirectory('/src')).toBe(true); // explicit, so it outlives its files
  });

  it('keeps exact strings: non-ASCII, a leading BOM, lone surrogates, empty files and odd paths', () => {
    const fs = new VirtualFileSystem();
    const odd = { '/bom.txt': '﻿hello', '/emoji.md': 'héllo 🌍 世界', '/lone.txt': 'a\uD800b\uDC00c\uD83D', '/empty.txt': '', '/sp ace/ünï\uD801.txt': 'x' };
    for (const [path, text] of Object.entries(odd)) fs.writeFile(path, text);
    fs.writeFile('/zero.bin', new Uint8Array(0));
    const copy = mounted(packFileSystem(fs, 1));
    for (const [path, text] of Object.entries(odd)) expect(copy.readFile(path)).toBe(text);
    expect(copy.readFile('/zero.bin')).toEqual(new Uint8Array(0));
    expect(copy.list()).toEqual(fs.list());
  });

  it('copies bytes out on read: a standalone array, and mutating it never reaches the pack', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.bin', new Uint8Array([1, 2, 3]));
    fs.writeFile('/b.bin', new Uint8Array([4, 5]));
    const pack = packFileSystem(fs, 0);
    const first = mounted(pack);
    const bytes = first.readFile('/a.bin') as Uint8Array;
    expect(bytes.buffer.byteLength).toBe(3);
    bytes[0] = 99;
    expect(mounted(pack).readFile('/a.bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(first.readFile('/a.bin')).toBe(bytes); // copied once, then it is the file's contents
  });

  it('reads contents lazily: the index mounts without decoding any file', () => {
    const fs = new VirtualFileSystem();
    for (let i = 0; i < 50; i++) fs.writeFile(`/lib/f${i}.js`, `module.exports = ${i};`);
    const { files } = readPack(packFileSystem(fs, 0));
    let reads = 0;
    const copy = new VirtualFileSystem();
    copy.seed(files.map(([path, read]) => [path, () => (reads++, read())] as const));
    expect(copy.readdir('/lib')).toHaveLength(50);
    expect(copy.isFile('/lib/f7.js')).toBe(true);
    expect(reads).toBe(0);
    expect(copy.readText('/lib/f7.js')).toBe('module.exports = 7;');
    expect(copy.readText('/lib/f7.js')).toBe('module.exports = 7;');
    expect(reads).toBe(1);
  });

  it('packs an empty file system and refuses a buffer that is not a pack', () => {
    expect(state(mounted(packFileSystem(new VirtualFileSystem(), 0)))).toEqual({ files: [], dirs: [] });
    expect(() => readPack(new ArrayBuffer(64))).toThrow(/Not a file-system pack/);
  });

  it('carries a sequence past 2^32', () => {
    expect(readPack(packFileSystem(new VirtualFileSystem(), 2 ** 40 + 5)).seq).toBe(2 ** 40 + 5);
  });
});
