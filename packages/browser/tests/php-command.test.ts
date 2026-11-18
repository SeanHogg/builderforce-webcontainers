/**
 * The PHP runtime's pure rules: which commands it runs and how it reads them,
 * `php -S` routing, Composer's versions and constraints, platform checks, and
 * the `php` provider's accept/decline. No php-wasm.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { NODE_ONLY } from '../src/node/processKinds.js';
import {
  PHP_KIND,
  acceptsPhpService,
  createPhpProcessKind,
  declaredClasses,
  expandMinified,
  frontScript,
  isPhpCommand,
  mapPhpInvocationPaths,
  parseConstraint,
  parsePhpCommand,
  parseVersion,
  phpLiteral,
  phpWasmModuleUrls,
  pickVersion,
  platformShortfall,
  routeRequest,
  satisfies,
  checkPhpVersion,
  type PackageVersion,
} from '../src/runtimes/php/index.js';

describe('PHP command lines', () => {
  it('recognises php and composer by base name', () => {
    for (const command of ['php', 'php8.3', 'php83', '/usr/bin/php', 'php.exe', 'composer', 'composer.phar']) expect(isPhpCommand(command)).toBe(true);
    for (const command of ['node', 'python', 'phpunit', 'composer2x']) expect(isPhpCommand(command)).toBe(false);
  });

  it('passes CLI invocations to PHP as written, and refuses interactive PHP', () => {
    expect(parsePhpCommand('php', ['app.php', 'x'])).toEqual({ ok: true, invocation: { kind: 'cli', argv: ['app.php', 'x'] } });
    expect(parsePhpCommand('php', ['-d', 'memory_limit=1G', '-r', 'echo 1;'])).toEqual({ ok: true, invocation: { kind: 'cli', argv: ['-d', 'memory_limit=1G', '-r', 'echo 1;'] } });
    expect(parsePhpCommand('php', [])).toMatchObject({ ok: false, reason: expect.stringContaining('needs a terminal') });
    expect(parsePhpCommand('php', ['-a'])).toMatchObject({ ok: false });
  });

  it('reads php -S with its document root, router and -d settings', () => {
    expect(parsePhpCommand('php', ['-S', '0.0.0.0:8000', '-t', 'public', '-d', 'display_errors=0', 'public/index.php'])).toEqual({
      ok: true,
      invocation: { kind: 'serve', server: { host: '0.0.0.0', port: 8000, docroot: 'public', router: 'public/index.php', ini: { display_errors: '0' } } },
    });
    expect(parsePhpCommand('php', ['-S', 'localhost'])).toMatchObject({ ok: false });
    expect(parsePhpCommand('php', ['-S', 'localhost:8000', 'a.php', 'b.php'])).toMatchObject({ ok: false, reason: expect.stringContaining('one router') });
  });

  it('reads Composer, including php composer.phar', () => {
    expect(parsePhpCommand('composer', ['install', '--no-dev', '-n'])).toMatchObject({ ok: true, invocation: { kind: 'composer', command: 'install', noDev: true } });
    expect(parsePhpCommand('php', ['composer.phar', 'require', 'slim/slim:^4.0', '--working-dir=api'])).toMatchObject({ ok: true, invocation: { kind: 'composer', command: 'require', packages: ['slim/slim:^4.0'], workingDir: 'api' } });
    expect(parsePhpCommand('composer', [])).toMatchObject({ ok: true, invocation: { command: 'install' } });
    expect(parsePhpCommand('composer', ['create-project', 'x'])).toMatchObject({ ok: false, reason: expect.stringContaining('not supported') });
    expect(parsePhpCommand('composer', ['require'])).toMatchObject({ ok: false });
  });

  it('maps absolute project paths into the PHP mount, leaving code and relative paths alone', () => {
    const map = (path: string) => `/project${path}`;
    expect(mapPhpInvocationPaths({ kind: 'cli', argv: ['/srv/app.php', '/data'] }, map)).toEqual({ kind: 'cli', argv: ['/project/srv/app.php', '/data'] });
    expect(mapPhpInvocationPaths({ kind: 'cli', argv: ['-r', 'echo "/x";'] }, map)).toEqual({ kind: 'cli', argv: ['-r', 'echo "/x";'] });
    expect(mapPhpInvocationPaths({ kind: 'serve', server: { host: 'h', port: 1, docroot: '/public', router: 'r.php', ini: {} } }, map)).toMatchObject({ server: { docroot: '/project/public', router: 'r.php' } });
  });

  it('routes PHP commands and PHP shebang scripts to the PHP Worker, the rest to the next policy', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'artisan': '#!/usr/bin/env php\n<?php echo 1;', 'tool.sh': '#!/bin/sh\necho hi' });
    const kinds = createPhpProcessKind({ phpVersion: '8.2' }, NODE_ONLY);
    expect(kinds.route('php', ['a.php'], { fs, cwd: '/', env: {} })).toEqual({ kind: PHP_KIND, command: 'php', args: ['a.php'] });
    expect(kinds.route('./artisan', ['serve'], { fs, cwd: '/', env: {} })).toEqual({ kind: PHP_KIND, command: 'php', args: ['/artisan', 'serve'] });
    expect(kinds.route('node', ['x.js'], { fs, cwd: '/', env: {} })).toEqual({ kind: 'node', command: 'node', args: ['x.js'] });
    expect(kinds.startOptions(PHP_KIND)).toEqual({ php: { phpVersion: '8.2' } });
    expect(kinds.startOptions('node')).toEqual({});
    expect(new RegExp(kinds.foreignCommands!).test('composer')).toBe(true);
  });

  it('accepts only PHP versions php-wasm builds, and names its module URLs', () => {
    expect(checkPhpVersion(undefined)).toBe('8.3');
    expect(() => checkPhpVersion('7.0')).toThrow(/not available/);
    expect(phpWasmModuleUrls('https://cdn.example/npm', '8.3', 'jspi')).toEqual({
      universal: 'https://cdn.example/npm/@php-wasm/universal@3.1.62/+esm',
      loader: 'https://cdn.example/npm/@php-wasm/web-8-3@3.1.62/jspi/php_8_3.js',
    });
  });
});

describe('php -S routing', () => {
  const files = new Set(['/www/index.php', '/www/info.php', '/www/app.css', '/www/docs/index.html', '/www/api/index.php']);
  const dirs = new Set(['/www', '/www/docs', '/www/api']);
  const tree = { isFile: (path: string) => files.has(path), isDir: (path: string) => dirs.has(path) };

  it('serves files, runs scripts, splits PATH_INFO and falls back to the nearest index', () => {
    expect(routeRequest('/app.css', '/www', tree)).toEqual({ kind: 'file', file: '/www/app.css' });
    expect(routeRequest('/info.php', '/www', tree)).toEqual({ kind: 'script', file: '/www/info.php', scriptName: '/info.php', pathInfo: undefined });
    expect(routeRequest('/info.php/a/b', '/www', tree)).toEqual({ kind: 'script', file: '/www/info.php', scriptName: '/info.php', pathInfo: '/a/b' });
    expect(routeRequest('/docs', '/www', tree)).toEqual({ kind: 'file', file: '/www/docs/index.html' });
    expect(routeRequest('/api/users/1', '/www', tree)).toEqual({ kind: 'script', file: '/www/api/index.php', scriptName: '/api/index.php', pathInfo: '/users/1' });
    expect(routeRequest('/users', '/www', tree)).toEqual({ kind: 'script', file: '/www/index.php', scriptName: '/index.php', pathInfo: '/users' });
    expect(routeRequest('/missing.js', '/www', tree)).toEqual({ kind: 'missing' });
  });

  it('writes -d settings into the front script', () => {
    expect(frontScript({ "it's": 'a\\b' })).toContain("ini_set('it\\'s', 'a\\\\b');");
  });
});

describe('Composer versions and constraints', () => {
  it('parses versions and their stabilities', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ parts: [1, 2, 3, 0], stability: 'stable' });
    expect(parseVersion('1.2.3.0-beta1')).toMatchObject({ stability: 'beta', pre: 1 });
    expect(parseVersion('2.0.0-RC2')).toMatchObject({ stability: 'RC', pre: 2 });
    expect(parseVersion('dev-main')).toMatchObject({ branch: 'dev-main', stability: 'dev' });
    expect(parseVersion('1.0.x-dev')).toMatchObject({ stability: 'dev' });
  });

  it.each([
    ['^1.2', '1.9.0', true],
    ['^1.2', '2.0.0', false],
    ['^1.2', '1.1.9', false],
    ['^0.3.1', '0.3.9', true],
    ['^0.3.1', '0.4.0', false],
    ['~1.2', '1.9', true],
    ['~1.2.3', '1.3.0', false],
    ['>=7.4', '8.3.0', true],
    ['^7.4 || ^8.0', '8.3.36', true],
    ['^7.4|^8.0', '7.3.0', false],
    ['>=1.0 <2.0', '1.5', true],
    ['>=1.0, <2.0', '2.0.0-beta1', false],
    ['1.2.*', '1.2.7', true],
    ['1.2.*', '1.3.0', false],
    ['1.0 - 2.0', '2.0.5', true],
    ['1.0 - 2.0', '2.1.0', false],
    ['!=1.5', '1.5.0', false],
    ['*', '9.9.9', true],
    ['dev-main', 'dev-main', true],
    ['1.0.0', '1.0.0', true],
  ])('%s against %s is %s', (constraint, version, expected) => {
    expect(satisfies(version, constraint)).toBe(expected);
  });

  it('picks the highest allowed version under minimum-stability, preferring stable when asked', () => {
    const versions = ['1.0.0', '1.1.0', '2.0.0-beta1', '1.2.0-RC1'].map((version): PackageVersion => ({ name: 'a/b', version }));
    const anything = [parseConstraint('*')!];
    expect(pickVersion(versions, anything, { minimumStability: 'stable', preferStable: false })?.version).toBe('1.1.0');
    expect(pickVersion(versions, anything, { minimumStability: 'beta', preferStable: false })?.version).toBe('2.0.0-beta1');
    expect(pickVersion(versions, anything, { minimumStability: 'beta', preferStable: true })?.version).toBe('1.1.0');
    expect(pickVersion(versions, [parseConstraint('^2.0@beta')!], { minimumStability: 'stable', preferStable: false })?.version).toBe('2.0.0-beta1');
  });

  it("expands Composer v2's minified metadata", () => {
    expect(expandMinified([{ version: '2.0', require: { php: '>=8' }, type: 'library' }, { version: '1.0', require: '__unset' }])).toEqual([
      { version: '2.0', require: { php: '>=8' }, type: 'library' },
      { version: '1.0', type: 'library' },
    ]);
  });
});

describe('platform requirements and the php provider', () => {
  const platform = { phpVersion: '8.3.36', extensions: new Set(['json', 'pdo', 'mbstring', 'zend opcache']) };

  it('checks php, extensions and Composer APIs, naming what is missing', () => {
    expect(platformShortfall('php', '^8.1', platform)).toBeUndefined();
    expect(platformShortfall('php', '^7.4', platform)).toMatch(/does not satisfy/);
    expect(platformShortfall('ext-mbstring', '*', platform)).toBeUndefined();
    expect(platformShortfall('ext-zend-opcache', '*', platform)).toBeUndefined();
    expect(platformShortfall('ext-pdo_pgsql', '*', platform)).toMatch(/Bfwc\\Pgsql\\PDO/);
    expect(platformShortfall('ext-redis', '*', platform)).toMatch(/not in the php-wasm image/);
    expect(platformShortfall('php-64bit', '*', platform)).toMatch(/32-bit/);
    expect(platformShortfall('composer-runtime-api', '^2.2', platform)).toBeUndefined();
  });

  it('accepts PHP services and declines others, and native extensions, with reasons', () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'api/composer.json': JSON.stringify({ require: { php: '>=8.1', 'slim/slim': '^4.12' } }), 'bad/composer.json': JSON.stringify({ require: { 'ext-pgsql': '*', 'ext-swoole': '*' } }) });
    expect(acceptsPhpService({ id: 'api', type: 'application', runtime: 'php', root: '/api', command: 'php', args: ['-S', '0.0.0.0:8000', '-t', 'public'], port: 8000 }, fs)).toEqual({ ok: true });
    expect(acceptsPhpService({ id: 'n', type: 'application', runtime: 'php', command: 'node', args: ['x.js'] })).toMatchObject({ ok: false, reason: expect.stringContaining('not a PHP command') });
    expect(acceptsPhpService({ id: 'i', type: 'application', runtime: 'php', command: 'php', args: ['-a'] })).toMatchObject({ ok: false, reason: expect.stringContaining('terminal') });
    const declined = acceptsPhpService({ id: 'bad', type: 'application', runtime: 'php', root: '/bad', command: 'php', args: ['-S', 'localhost:8000'] }, fs);
    expect(declined).toMatchObject({ ok: false });
    expect(!declined.ok && declined.reason).toMatch(/ext-pgsql[\s\S]*ext-swoole/);
  });
});

describe('autoload generation helpers', () => {
  it('finds declared classes under their namespace, skipping comments', () => {
    expect(declaredClasses('<?php\nnamespace App\\Models;\n/* class Fake {} */\nfinal class User {}\ninterface Repo {}\nenum Status: string {}\n')).toEqual(['App\\Models\\User', 'App\\Models\\Repo', 'App\\Models\\Status']);
  });

  it('writes PHP literals, with project paths relative to $baseDir', () => {
    expect(phpLiteral({ 'App\\': ['/p/src'], n: 1, f: false }, (text) => (text.startsWith('/p/') ? `$baseDir . '${text.slice(2)}'` : undefined))).toBe("['App\\\\' => [$baseDir . '/src'], 'n' => 1, 'f' => false]");
  });
});
