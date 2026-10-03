import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '../../src/vfs.js';
import { installPackages, type InstallOptions } from '../../src/installer/install.js';
import { createMemoryCache } from '../../src/installer/registry.js';
import { readBinLink } from '../../src/installer/bins.js';
import { fakeRegistry, REGISTRY, type FixturePackage } from './fakeRegistry.js';

const version = (fs: VirtualFileSystem, location: string) => JSON.parse(fs.readText(`/${location}/package.json`) ?? 'null')?.version;

function project(pkg: object, extra: Record<string, string> = {}): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.mount({ 'package.json': JSON.stringify(pkg), ...extra });
  return fs;
}

async function setup(packages: Record<string, FixturePackage>, pkg: object) {
  const registry = await fakeRegistry(packages);
  const fs = project(pkg);
  const run = (extra: Partial<InstallOptions> = {}) => installPackages({ fs, fetch: registry.fetch, registry: REGISTRY, ...extra });
  return { registry, fs, run };
}

describe('installPackages', () => {
  it('hoists compatible versions and nests conflicts', async () => {
    const { fs, run } = await setup(
      {
        a: { versions: { '1.0.0': { dependencies: { c: '^1.0.0' } } } },
        b: { versions: { '1.0.0': { dependencies: { c: '^2.0.0', d: '^1.0.0' } } } },
        c: { versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} }, tags: { latest: '1.5.0' } },
        d: { versions: { '1.0.0': { dependencies: { c: '^1.2.0' } } } },
      },
      { dependencies: { a: '^1.0.0', b: '^1.0.0' } },
    );
    const result = await run();
    expect(version(fs, 'node_modules/c')).toBe('1.5.0');
    expect(version(fs, 'node_modules/b/node_modules/c')).toBe('2.0.0');
    expect(version(fs, 'node_modules/d')).toBe('1.0.0'); // hoisted, and dedupes onto the top-level c@1.5.0
    expect(fs.exists('/node_modules/d/node_modules')).toBe(false);
    expect(fs.readText('/node_modules/a/index.js')).toBe('module.exports = "a@1.0.0";');
    expect(result.total).toBe(5);
    expect(result.added).toBe(5);
  });

  it('nests deeper rather than shadow a version a sibling already resolves to', async () => {
    const { fs, run } = await setup(
      {
        b: { versions: { '1.0.0': { dependencies: { x: '^1.0.0', y: '^1.0.0' } } } },
        r: { versions: { '1.0.0': {}, '2.0.0': {} } },
        x: { versions: { '1.0.0': { dependencies: { r: '^1.0.0' } }, '2.0.0': {} } },
        y: { versions: { '1.0.0': { dependencies: { r: '^2.0.0' } }, '2.0.0': {} } },
      },
      { dependencies: { b: '1.0.0', r: '^1.0.0', x: '^2.0.0', y: '^2.0.0' } },
    );
    await run();
    expect(version(fs, 'node_modules/b/node_modules/x')).toBe('1.0.0');
    expect(fs.exists('/node_modules/b/node_modules/r')).toBe(false); // would shadow r@1 for b/x
    expect(version(fs, 'node_modules/b/node_modules/y/node_modules/r')).toBe('2.0.0');
  });

  it('writes a v3 lockfile and reinstalls from it without asking the registry for metadata', async () => {
    const packages = {
      a: { versions: { '1.0.0': { dependencies: { c: '^1.0.0' } } } },
      c: { versions: { '1.0.0': {} } },
    };
    const { fs, run } = await setup(packages, { name: 'app', dependencies: { a: '^1.0.0' } });
    await run();
    const lock = JSON.parse(fs.readText('/package-lock.json')!);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']).toMatchObject({ name: 'app', dependencies: { a: '^1.0.0' } });
    expect(lock.packages['node_modules/c']).toMatchObject({ version: '1.0.0', resolved: `${REGISTRY}/c/-/c-1.0.0.tgz` });
    expect(lock.packages['node_modules/c'].integrity).toMatch(/^sha512-/);

    // A fresh checkout: package.json + lockfile only. Even if the registry has moved on, the lock wins.
    const registry2 = await fakeRegistry({ ...packages, c: { versions: { '1.0.0': {}, '1.9.0': {} } } });
    const fs2 = project({ name: 'app', dependencies: { a: '^1.0.0' } }, { 'package-lock.json': fs.readText('/package-lock.json')! });
    await installPackages({ fs: fs2, fetch: registry2.fetch, registry: REGISTRY });
    expect(registry2.packumentRequests()).toEqual([]);
    expect(version(fs2, 'node_modules/c')).toBe('1.0.0');
  });

  it('reuses cached tarballs across installs', async () => {
    const { registry, run, fs } = await setup({ a: { versions: { '1.0.0': {} } } }, { dependencies: { a: '1' } });
    const cache = createMemoryCache();
    await run({ cache });
    fs.rm('/node_modules');
    await run({ cache });
    expect(registry.tarballRequests()).toHaveLength(1);
    expect(registry.packumentRequests()).toHaveLength(1);
  });

  it('links bins and records them', async () => {
    const { fs, run } = await setup(
      { tool: { versions: { '1.0.0': { bin: { tool: './cli.js', 'tool-alt': 'cli.js' }, files: { 'cli.js': 'console.log("hi")' } } } } },
      { devDependencies: { tool: '^1.0.0' } },
    );
    const result = await run();
    expect(result.bins).toEqual({ tool: '/node_modules/tool/cli.js', 'tool-alt': '/node_modules/tool/cli.js' });
    expect(readBinLink(fs, '/node_modules/.bin/tool')).toBe('/node_modules/tool/cli.js');
    expect(JSON.parse(fs.readText('/package-lock.json')!).packages['node_modules/tool'].dev).toBe(true);
  });

  it('adds specs to package.json, saving ^latest or the given range', async () => {
    const { fs, run } = await setup(
      { a: { versions: { '1.0.0': {}, '1.2.0': {} } }, b: { versions: { '3.0.0': {}, '4.0.0-beta.1': {} }, tags: { latest: '3.0.0', next: '4.0.0-beta.1' } } },
      { dependencies: {} },
    );
    await run({ add: ['a', 'b@next'] });
    await run({ add: ['a@~1.0.0'], saveDev: true });
    const pkg = JSON.parse(fs.readText('/package.json')!);
    expect(pkg.dependencies).toEqual({ b: '^4.0.0-beta.1' });
    expect(pkg.devDependencies).toEqual({ a: '~1.0.0' });
    expect(version(fs, 'node_modules/a')).toBe('1.0.0');
  });

  it('prunes packages that are no longer depended on', async () => {
    const { fs, run } = await setup(
      { a: { versions: { '1.0.0': { dependencies: { c: '1.0.0' } } } }, b: { versions: { '1.0.0': {} } }, c: { versions: { '1.0.0': {} } } },
      { dependencies: { a: '1.0.0', b: '1.0.0' } },
    );
    await run();
    fs.writeFile('/package.json', JSON.stringify({ dependencies: { b: '1.0.0' } }));
    const result = await run();
    expect(result.removed).toBe(2);
    expect(fs.readdir('/node_modules').filter((n) => !n.startsWith('.'))).toEqual(['b']);
  });

  it('npm ci refuses a missing or stale lockfile', async () => {
    const { fs, run } = await setup({ a: { versions: { '1.0.0': {} } } }, { dependencies: { a: '1' } });
    await expect(run({ ci: true })).rejects.toThrow(/needs a package-lock/);
    await run();
    fs.writeFile('/package.json', JSON.stringify({ dependencies: { a: '^1' } }));
    await expect(run({ ci: true })).rejects.toThrow(/out of sync/);
  });

  it('skips optional native binaries for other platforms and reports install scripts', async () => {
    const { fs, run } = await setup(
      {
        tool: { versions: { '1.0.0': { optionalDependencies: { 'tool-linux-x64': '1.0.0', missing: '1.0.0' }, hasInstallScript: true } } },
        'tool-linux-x64': { versions: { '1.0.0': { os: ['linux'], cpu: ['x64'] } } },
      },
      { dependencies: { tool: '1.0.0' } },
    );
    const result = await run();
    expect(fs.exists('/node_modules/tool-linux-x64')).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/skipped optional missing/);
    expect(result.warnings.join('\n')).toMatch(/skipped install scripts of tool@1.0.0/);
  });

  it('installs peer dependencies beside the package that wants them', async () => {
    const { fs, run } = await setup(
      { plugin: { versions: { '1.0.0': { peerDependencies: { host: '^2.0.0' } } } }, host: { versions: { '2.0.0': {} } } },
      { dependencies: { plugin: '1.0.0' } },
    );
    await run();
    expect(version(fs, 'node_modules/host')).toBe('2.0.0');
  });

  it('installs npm: aliases and scoped packages', async () => {
    const { fs, run } = await setup({ '@scope/real': { versions: { '1.0.0': {} } } }, { dependencies: { nick: 'npm:@scope/real@^1.0.0', '@scope/real': '1.0.0' } });
    await run();
    expect(JSON.parse(fs.readText('/node_modules/nick/package.json')!).name).toBe('@scope/real');
    expect(version(fs, 'node_modules/@scope/real')).toBe('1.0.0');
  });

  it('fails on an integrity mismatch and on unknown packages', async () => {
    const { registry, run, fs } = await setup({ a: { versions: { '1.0.0': {} } } }, { dependencies: { a: '1.0.0' } });
    registry.corrupt('a', '1.0.0');
    await expect(run()).rejects.toThrow(/Integrity check failed/);
    fs.writeFile('/package.json', JSON.stringify({ dependencies: { nope: '1' } }));
    await expect(run()).rejects.toThrow(/"nope" was not found/);
  });
});
