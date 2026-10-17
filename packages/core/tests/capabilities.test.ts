import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, type FsChange } from '../src/vfs.js';
import { exportZip, importZip } from '../src/archive.js';
import { authHeaders, parseNpmrc, readNpmConfig, registryFor } from '../src/installer/npmrc.js';
import { RegistryClient, type FetchLike } from '../src/installer/registry.js';
import { transformHtml, CONSOLE_MESSAGE_TYPE } from '../src/html.js';
import { DevServer } from '../src/devServer.js';
import type { Transformer } from '../src/transformer.js';

const tree = (files: Record<string, string>) => {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return fs;
};

describe('VirtualFileSystem: rename, entries, scoped watch', () => {
  it('renames a file and a directory with everything under it', () => {
    const fs = tree({ 'a.txt': 'a', 'src/x.ts': 'x', 'src/deep/y.ts': 'y' });
    fs.mkdir('/src/empty');
    fs.rename('/a.txt', '/b.txt');
    fs.rename('/src', '/lib');
    expect(fs.list()).toEqual(['/b.txt', '/lib/deep/y.ts', '/lib/x.ts']);
    expect(fs.isDirectory('/lib/empty')).toBe(true);
    expect(fs.exists('/src')).toBe(false);
    expect(() => fs.rename('/missing', '/z')).toThrow(/ENOENT/);
    expect(() => fs.rename('/b.txt', '/lib/x.ts')).toThrow(/EEXIST/);
    expect(() => fs.rename('/lib', '/lib/inner')).toThrow(/EINVAL/);
  });

  it('lists entries with their kind', () => {
    const fs = tree({ 'index.html': '', 'src/main.ts': '' });
    expect(fs.entries('/')).toEqual([{ name: 'index.html', kind: 'file' }, { name: 'src', kind: 'directory' }]);
  });

  it('watches only changes under a path when asked', () => {
    const fs = new VirtualFileSystem();
    const seen: FsChange[] = [];
    fs.watch((change) => seen.push(change), { under: '/src' });
    fs.writeFile('/src/a.ts', '1');
    fs.writeFile('/srcx.ts', '2');
    fs.writeFile('/other/b.ts', '3');
    expect(seen.map((c) => c.path)).toEqual(['/src/a.ts']);
  });
});

describe('zip export and import', () => {
  it('round-trips text, bytes and empty directories, honouring excludes', () => {
    const fs = tree({ 'index.html': '<p>hi</p>', 'node_modules/react/index.js': 'module.exports = 1' });
    fs.writeFile('/logo.png', new Uint8Array([0x89, 0x50, 0xff, 0x00]));
    fs.mkdir('/public');

    const restored = new VirtualFileSystem();
    importZip(restored, exportZip(fs, { exclude: ['node_modules'] }));
    expect(restored.list()).toEqual(['/index.html', '/logo.png']);
    expect(restored.readFile('/index.html')).toBe('<p>hi</p>');
    expect(restored.readFile('/logo.png')).toEqual(new Uint8Array([0x89, 0x50, 0xff, 0x00]));
    expect(restored.isDirectory('/public')).toBe(true);

    const full = new VirtualFileSystem();
    importZip(full, exportZip(fs, { level: 0 }), '/copy');
    expect(full.readText('/copy/node_modules/react/index.js')).toBe('module.exports = 1');
  });
});

describe('.npmrc', () => {
  const config = parseNpmrc(
    ['registry=https://mirror.example.com/', '@acme:registry=https://npm.acme.dev/', '//npm.acme.dev/:_authToken=${NPM_TOKEN}', '# comment'].join('\n'),
    { NPM_TOKEN: 'secret' },
  );

  it('parses the default registry, scoped registries and tokens with env expansion', () => {
    expect(config).toEqual({ registry: 'https://mirror.example.com', scopes: { '@acme': 'https://npm.acme.dev' }, tokens: { '//npm.acme.dev/': 'secret' } });
    expect(registryFor(config, '@acme/ui', 'https://registry.npmjs.org')).toBe('https://npm.acme.dev');
    expect(registryFor(config, 'react', 'https://registry.npmjs.org')).toBe('https://registry.npmjs.org');
    expect(authHeaders(config, 'https://npm.acme.dev/@acme%2fui')).toEqual({ authorization: 'Bearer secret' });
    expect(authHeaders(config, 'https://registry.npmjs.org/react')).toEqual({});
  });

  it('lets the project file override the user file', () => {
    const fs = tree({ 'home/.npmrc': 'registry=https://user.example/', 'app/.npmrc': 'registry=https://project.example/' });
    expect(readNpmConfig(fs, ['/home/.npmrc', '/app/.npmrc', '/missing/.npmrc']).registry).toBe('https://project.example');
  });

  it('sends the token to the scoped registry only', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const packument = { name: '@acme/ui', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: '@acme/ui', version: '1.0.0', dist: { tarball: 'https://npm.acme.dev/ui.tgz' } } } };
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(packument)).buffer as ArrayBuffer };
    };
    await new RegistryClient({ fetch, npmrc: config }).packument('@acme/ui');
    expect(calls[0]!.url).toBe('https://npm.acme.dev/@acme%2Fui');
    expect(calls[0]!.headers?.authorization).toBe('Bearer secret');
  });
});

describe('preview bridge', () => {
  it('forwards console output and runs host scripts before the app, escaping </script>', () => {
    const html = transformHtml('<html><head></head><body></body></html>', { base: '/p/', attribution: false, scripts: ['window.hook = "</script>"'] });
    expect(html).toContain(CONSOLE_MESSAGE_TYPE);
    expect(html).toContain('window.hook = "<\\/script>"');
    expect(html.indexOf('window.hook')).toBeGreaterThan(html.indexOf(CONSOLE_MESSAGE_TYPE));
  });

  it('swaps preview scripts at runtime', async () => {
    const transformer = { transform: async ({ code }: { code: string }) => ({ code }) } as unknown as Transformer;
    const fs = tree({ 'index.html': '<html><head></head><body></body></html>', 'package.json': '{"devDependencies":{"vite":"^5"}}' });
    const server = new DevServer({ fs, transformer, base: '/p/', attribution: false, previewScripts: ['window.a = 1'] });
    const page = async () => String((await server.handle('/')).body);
    expect(await page()).toContain('window.a = 1');
    server.setPreviewScripts(['window.b = 2']);
    expect(await page()).toContain('window.b = 2');
    expect(await page()).not.toContain('window.a = 1');
  });
});
