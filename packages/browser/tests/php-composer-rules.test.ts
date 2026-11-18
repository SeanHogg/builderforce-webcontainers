/**
 * The Composer installer's rules, without php-wasm: backtracking resolution
 * (constraints rebuilt from the branch, so a dropped version's constraints go
 * with it), root/package `provide`/`replace`/`conflict`, platform-driven
 * fallbacks, partial updates preferring locked versions, package-name
 * validation, `require` argument forms, unsupported repositories, the lock's
 * runtime/dev split, autoload `files` order, and dist limits that no fallback
 * can bypass.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem, exportZip } from '@seanhogg/builderforce-webcontainers-core';
import {
  DistRefused,
  ResolveError,
  createPackageSource,
  dependencyOrder,
  encodePackageName,
  requireArguments,
  resolvePackages,
  rootRequirements,
  runtimePackages,
  unsupportedRepositories,
  validPackageName,
  type PackageSource,
  type PackageVersion,
} from '../src/runtimes/php/index.js';

type Spec = Omit<PackageVersion, 'name'>;

/** A repository from `name → versions`. */
function repository(packages: Record<string, Spec[]>): PackageSource {
  return {
    versions: async (name) => packages[name]?.map((spec) => ({ ...spec, name })),
    files: async () => new Map(),
  };
}

const options = { minimumStability: 'stable' as const, preferStable: true };
const root = (require: Record<string, string>) => rootRequirements({ require }, false);
const versions = (resolution: Awaited<ReturnType<typeof resolvePackages>>) => Object.fromEntries([...resolution.packages].map(([name, pkg]) => [name, pkg.version]));

describe('resolution', () => {
  it('backtracks: a/a 2.0 needs c ^2, b/b needs a ^1, so a/a 1.0 (needing c ^1) wins and c ^2 is not kept', async () => {
    const repo = repository({
      'a/a': [{ version: '2.0.0', require: { 'c/c': '^2.0' } }, { version: '1.0.0', require: { 'c/c': '^1.0' } }],
      'b/b': [{ version: '1.0.0', require: { 'a/a': '^1.0' } }],
      'c/c': [{ version: '2.0.0' }, { version: '1.0.0' }],
    });
    expect(versions(await resolvePackages(root({ 'a/a': '*', 'b/b': '*' }), repo, options))).toEqual({ 'a/a': '1.0.0', 'b/b': '1.0.0', 'c/c': '1.0.0' });
  });

  it('reports a genuine conflict with the constraints that clash', async () => {
    const repo = repository({ 'a/a': [{ version: '1.0.0' }], 'b/b': [{ version: '1.0.0', require: { 'a/a': '^2.0' } }] });
    await expect(resolvePackages(root({ 'a/a': '^1.0', 'b/b': '*' }), repo, options)).rejects.toThrow(/a\/a.*\^2\.0|\^2\.0.*a\/a/);
    await expect(resolvePackages(root({ 'a/a': '^1.0', 'b/b': '*' }), repo, options)).rejects.toBeInstanceOf(ResolveError);
  });

  it('skips a release the running PHP cannot run, for an older one that can', async () => {
    const repo = repository({ 'a/a': [{ version: '2.0.0', require: { php: '>=9.0' } }, { version: '1.5.0', require: { php: '>=8.1', 'ext-json': '*' } }] });
    const platform = { phpVersion: '8.3.36', extensions: new Set(['json']) };
    expect(versions(await resolvePackages(root({ 'a/a': '*' }), repo, { ...options, platform }))).toEqual({ 'a/a': '1.5.0' });
    await expect(resolvePackages(root({ 'a/a': '^2.0' }), repo, { ...options, platform })).rejects.toThrow(/declined.*PHP 8\.3\.36/);
  });

  it('satisfies virtual and replaced packages by provide/replace, and honours conflict — the root included', async () => {
    const repo = repository({
      'impl/psr': [{ version: '1.0.0', provide: { 'psr/log-implementation': '1.0' } }],
      'app/needs-log': [{ version: '1.0.0', require: { 'psr/log-implementation': '^1.0' } }],
      'big/framework': [{ version: '1.0.0', replace: { 'big/part': 'self.version' } }],
      'uses/part': [{ version: '1.0.0', require: { 'big/part': '*' } }],
      'x/x': [{ version: '2.0.0' }, { version: '1.0.0' }],
    });
    const solved = versions(await resolvePackages(root({ 'impl/psr': '*', 'app/needs-log': '*', 'big/framework': '*', 'uses/part': '*', 'x/x': '*' }), repo, options, { conflict: { 'x/x': '>=2.0' } }));
    expect(solved).toEqual({ 'impl/psr': '1.0.0', 'app/needs-log': '1.0.0', 'big/framework': '1.0.0', 'uses/part': '1.0.0', 'x/x': '1.0.0' });
    const provided = await resolvePackages(root({ 'app/needs-log': '*' }), repo, options, { provide: { 'psr/log-implementation': '1.0' } });
    expect([...provided.packages.keys()]).toEqual(['app/needs-log']);
  });

  it('a partial update keeps the other locked versions unless they must move', async () => {
    const repo = repository({ 'a/a': [{ version: '1.2.0' }, { version: '1.1.0' }], 'b/b': [{ version: '3.1.0' }, { version: '3.0.0' }] });
    const solved = await resolvePackages(root({ 'a/a': '^1.0', 'b/b': '^3.0' }), repo, { ...options, preferred: new Map([['b/b', '3.0.0']]) });
    expect(versions(solved)).toEqual({ 'a/a': '1.2.0', 'b/b': '3.0.0' });
  });

  it('splits the lock into runtime and dev packages by reachability from require', () => {
    const chosen = new Map<string, PackageVersion>([
      ['a/a', { name: 'a/a', version: '1.0.0', require: { 'c/c': '*' } }],
      ['c/c', { name: 'c/c', version: '1.0.0' }],
      ['t/test', { name: 't/test', version: '1.0.0' }],
    ]);
    expect([...runtimePackages({ require: { 'a/a': '*' }, 'require-dev': { 't/test': '*' } }, chosen)].sort()).toEqual(['a/a', 'c/c']);
  });
});

describe('package names, arguments and repositories', () => {
  it("validates names with Composer's pattern", () => {
    for (const name of ['slim/slim', 'symfony/polyfill-php80', 'a.b/c_d', 'vendor/x--y']) expect(validPackageName(name)).toBe(true);
    for (const name of ['../etc/passwd', 'slim', 'Slim/Slim', 'a/b/c', 'a/../b', 'a/b?x=1', '-a/b']) expect(validPackageName(name)).toBe(false);
    expect(encodePackageName('a.b/c_d')).toBe('a.b/c_d');
  });

  it('refuses invalid names before any request is made', async () => {
    const requested: string[] = [];
    const source = createPackageSource({ repositoryUrl: 'https://repo.test/{name}.json', fetch: async (url) => (requested.push(String(url)), new Response('{}', { status: 404 })) });
    await expect(source.versions('../../admin')).rejects.toThrow(/Invalid package name/);
    await expect(resolvePackages(root({ 'a/a': '*' }), repository({ 'a/a': [{ version: '1.0.0', require: { '../evil': '*' } }] }), options)).rejects.toThrow(/Invalid package name/);
    expect(requested).toEqual([]);
  });

  it('reads require arguments in every form', () => {
    expect(requireArguments(['slim/slim:^4.0', 'slim/psr7', '^1.6', 'psr/log=^3', 'x/y'])).toEqual([
      { name: 'slim/slim', constraint: '^4.0' },
      { name: 'slim/psr7', constraint: '^1.6' },
      { name: 'psr/log', constraint: '^3' },
      { name: 'x/y' },
    ]);
    expect(() => requireArguments(['Not/Valid!'])).toThrow(/Invalid package name/);
  });

  it('declines repositories other than Packagist, naming their types', () => {
    expect(unsupportedRepositories({})).toBeUndefined();
    expect(unsupportedRepositories({ repositories: [{ type: 'composer', url: 'https://repo.packagist.org' }] })).toBeUndefined();
    expect(unsupportedRepositories({ repositories: [{ type: 'path', url: '../lib' }, { type: 'vcs', url: 'https://x' }] })).toMatch(/type path, vcs/);
    expect(unsupportedRepositories({ repositories: { 'packagist.org': false } })).toMatch(/packagist\.org: false/);
  });

  it('orders packages after what they require (autoload files load dependencies first)', () => {
    const order = dependencyOrder([
      { name: 'a/app', version: '1', require: { 'b/lib': '*' } },
      { name: 'b/lib', version: '1', require: { 'c/base': '*' } },
      { name: 'c/base', version: '1' },
    ]).map((pkg) => pkg.name);
    expect(order).toEqual(['c/base', 'b/lib', 'a/app']);
  });
});

describe('dist limits', () => {
  const pkg = (dist: PackageVersion['dist']): PackageVersion => ({ name: 'a/a', version: '1.0.0', dist, source: { type: 'git', url: 'https://github.com/a/a.git', reference: 'abc123' } });

  it('an oversized zip is refused, and never retried from jsDelivr', async () => {
    const requested: string[] = [];
    const source = createPackageSource({
      fetch: async (url) => {
        requested.push(String(url));
        return new Response('x', { headers: { 'content-length': String(1024 * 1024 * 1024) } });
      },
    });
    await expect(source.files(pkg({ type: 'zip', url: 'https://api.github.com/repos/a/a/zipball/abc123', reference: 'abc123' }))).rejects.toBeInstanceOf(DistRefused);
    expect(requested).toEqual(['https://api.github.com/repos/a/a/zipball/abc123']);
  });

  it('a zip whose checksum does not match is refused; a matching one unpacks with its top directory stripped', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'a-a-abc123/src/A.php': '<?php class A {}' });
    const zip = exportZip(fs);
    const sha1 = [...new Uint8Array(await crypto.subtle.digest('SHA-1', zip))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const source = createPackageSource({ fetch: async () => new Response(zip) });
    await expect(source.files(pkg({ type: 'zip', url: 'https://x.test/a.zip', shasum: '0'.repeat(40) }))).rejects.toThrow(/checksum mismatch/);
    expect([...(await source.files(pkg({ type: 'zip', url: 'https://x.test/a.zip', shasum: sha1 }))).keys()]).toEqual(['src/A.php']);
  });

  it('falls back to jsDelivr only when the zip cannot be fetched, and holds the files to the same limits', async () => {
    const requested: string[] = [];
    const source = createPackageSource({
      fetch: async (url) => {
        const href = String(url);
        requested.push(href);
        if (href.startsWith('https://api.github.com/')) throw new TypeError('Failed to fetch (CORS)');
        if (href.startsWith('https://data.jsdelivr.com/')) return Response.json({ files: [{ name: '/src/A.php' }, { name: '/../escape.php' }] });
        return new Response('<?php');
      },
    });
    await expect(source.files(pkg({ type: 'zip', url: 'https://api.github.com/repos/a/a/zipball/abc123', reference: 'abc123' }))).rejects.toThrow(/Refusing file/);
    expect(requested.some((url) => url.startsWith('https://data.jsdelivr.com/'))).toBe(true);
  });
});
