/**
 * `runComposer` on an in-memory project (no php-wasm): names from
 * installed.json and composer.lock can never reach outside vendor/, packages
 * whose names start like platform names (`php-di/…`, `php-http/…`) install,
 * a download that fails changes nothing, a vendor directory that went missing
 * is installed again, and `composer require` without a constraint picks a
 * release the running PHP can run.
 */
import { describe, expect, it } from 'vitest';
import { join } from '@seanhogg/builderforce-webcontainers-core';
import { runComposer, type ComposerFiles, type ComposerRequest, type PackageSource, type PackageVersion } from '../src/runtimes/php/index.js';

/** A project held in a Map (absolute paths), with the calls the installer makes. */
function memoryFiles(initial: Record<string, string>) {
  const store = new Map<string, string | Uint8Array>(Object.entries(initial));
  const removed: string[] = [];
  const files: ComposerFiles = {
    read: (path) => {
      const value = store.get(path);
      return value === undefined ? undefined : typeof value === 'string' ? value : new TextDecoder().decode(value);
    },
    write: (path, content) => void store.set(path, content),
    isDir: (path) => [...store.keys()].some((key) => key.startsWith(`${path}/`)),
    list: (dir) => [...store.keys()].filter((key) => key.startsWith(`${dir}/`)),
    remove(path) {
      removed.push(path);
      for (const key of [...store.keys()]) if (key === path || key.startsWith(`${path}/`)) store.delete(key);
    },
  };
  return { files, store, removed };
}

type Spec = Omit<PackageVersion, 'name'>;

function source(packages: Record<string, Spec[]>, failing = new Set<string>()): PackageSource & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    versions: async (name) => packages[name]?.map((spec) => ({ ...spec, name }) as PackageVersion),
    async files(pkg) {
      downloads.push(pkg.name);
      if (failing.has(pkg.name)) throw new Error(`GET ${pkg.name}: 503 Service Unavailable`);
      return new Map([[`src/${pkg.name.split('/')[1]}.php`, new TextEncoder().encode('<?php')]]);
    },
  };
}

const request = (command: ComposerRequest['command'], packages: string[] = []): ComposerRequest => ({ command, packages, noDev: false, ignorePlatformReqs: false, dev: false });

async function composer(files: ComposerFiles, src: PackageSource, req: ComposerRequest, phpVersion = '8.3.36') {
  let output = '';
  const code = await runComposer(req, {
    files,
    source: src,
    platform: { phpVersion, extensions: new Set(['json']) },
    projectDir: '/app',
    contentHash: async () => '0'.repeat(32),
    out: (line) => (output += line),
    err: (line) => (output += line),
  });
  return { code, output };
}

const dist = { type: 'zip', url: 'https://example.test/x.zip' };

describe('runComposer', () => {
  it('refuses installed.json and lock entries whose names climb out of vendor/, and removes nothing', async () => {
    for (const name of ['php-a/../..', 'ext-a/../../b', '../escape', 'a/b/../../..']) {
      const installed = memoryFiles({
        '/app/composer.json': JSON.stringify({ require: {} }),
        '/app/src/keep.php': '<?php',
        '/app/vendor/composer/installed.json': JSON.stringify({ packages: [{ name, version: '1.0.0' }] }),
      });
      const fromInstalled = await composer(installed.files, source({}), request('install'));
      expect(fromInstalled.code).toBe(2);
      expect(fromInstalled.output).toContain('Invalid package name');
      expect(installed.removed).toEqual([]);
      expect(installed.store.has('/app/src/keep.php')).toBe(true);

      const locked = memoryFiles({ '/app/composer.json': JSON.stringify({ require: {} }), '/app/composer.lock': JSON.stringify({ packages: [{ name, version: '1.0.0', dist }] }) });
      const fromLock = await composer(locked.files, source({}), request('install'));
      expect(fromLock.code).toBe(2);
      expect(fromLock.output).toContain('Invalid package name');
      expect([...locked.store.keys()].every((key) => key.startsWith('/app/composer.'))).toBe(true);
    }
  });

  it('installs packages whose names start like platform names (php-di/php-di, php-http/discovery)', async () => {
    const { files, store } = memoryFiles({ '/app/composer.json': JSON.stringify({ require: { 'php-http/discovery': '^1.0' } }) });
    const src = source({ 'php-di/php-di': [{ version: '7.0.0', dist, require: { php: '>=8.0' } }], 'php-http/discovery': [{ version: '1.19.0', dist }] });
    const install = await composer(files, src, request('install'));
    expect(install.code, install.output).toBe(0);
    expect(store.has('/app/vendor/php-http/discovery/src/discovery.php')).toBe(true);
    const required = await composer(files, src, request('require', ['php-di/php-di']));
    expect(required.code, required.output).toBe(0);
    expect(store.has('/app/vendor/php-di/php-di/src/php-di.php')).toBe(true);
    expect(JSON.parse(store.get('/app/composer.json') as string).require).toEqual({ 'php-http/discovery': '^1.0', 'php-di/php-di': '^7.0' });
  });

  it('a download that fails changes nothing; the next run installs; a missing vendor directory is installed again', async () => {
    const lock = { packages: [{ name: 'a/one', version: '1.0.0', dist }, { name: 'b/two', version: '1.0.0', dist }] };
    const before = { packages: [{ name: 'old/gone', version: '1.0.0' }] };
    const { files, store } = memoryFiles({
      '/app/composer.json': JSON.stringify({ require: { 'a/one': '*', 'b/two': '*' } }),
      '/app/composer.lock': JSON.stringify(lock),
      '/app/vendor/composer/installed.json': JSON.stringify(before),
      '/app/vendor/old/gone/src/gone.php': '<?php',
    });
    const failing = await composer(files, source({}, new Set(['b/two'])), request('install'));
    expect(failing.code).toBe(1);
    expect(failing.output).toContain('503');
    expect(store.has('/app/vendor/old/gone/src/gone.php')).toBe(true); // removals wait for every download
    expect(store.has('/app/vendor/a/one/src/one.php')).toBe(false);
    expect(JSON.parse(store.get('/app/vendor/composer/installed.json') as string)).toEqual(before);

    const retry = await composer(files, source({}), request('install'));
    expect(retry.code, retry.output).toBe(0);
    expect(store.has('/app/vendor/b/two/src/two.php')).toBe(true);
    expect(store.has('/app/vendor/old/gone/src/gone.php')).toBe(false);

    for (const key of [...store.keys()]) if (key.startsWith(join('/app/vendor', 'a/one'))) store.delete(key);
    const src = source({});
    const again = await composer(files, src, request('install'));
    expect(again.code).toBe(0);
    expect(src.downloads).toEqual(['a/one']);
    expect(store.has('/app/vendor/a/one/src/one.php')).toBe(true);
  });

  it('require without a constraint picks the newest release the running PHP can run', async () => {
    const { files, store } = memoryFiles({ '/app/composer.json': JSON.stringify({ require: {} }) });
    const src = source({ 'a/lib': [{ version: '3.0.0', dist, require: { php: '>=8.4' } }, { version: '2.5.0', dist, require: { php: '>=8.1' } }] });
    const result = await composer(files, src, request('require', ['a/lib']), '8.3.36');
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(store.get('/app/composer.json') as string).require).toEqual({ 'a/lib': '^2.5' });
  });
});
