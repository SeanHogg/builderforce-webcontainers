/**
 * `composer` in the PHP runtime. Offline: a local stand-in for Packagist (its
 * package API) serving zip dists built here, so resolution, the lock file,
 * vendor/, the autoloader (PSR-4, files, class map, InstalledVersions) and the
 * decline of a package needing a missing extension run without the network.
 * Online (skipped with the reason when Packagist or GitHub is unreachable or
 * rate-limited): `composer install` of Slim 4 + slim/psr7 from the real
 * Packagist, then a Slim app doing CRUD against the PGlite database through the
 * runtime's PDO — PRD 31 §W9 phase 6b's exit condition.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFileSystem, exportZip } from '@seanhogg/builderforce-webcontainers-core';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec } from '../src/app.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { jsonOf, phpHost, phpWorkers, readAll, request } from './php-helpers.js';

interface FixtureVersion {
  version: string;
  require?: Record<string, string>;
  autoload?: Record<string, unknown>;
  files: Record<string, string>;
}

const FIXTURES: Record<string, FixtureVersion[]> = {
  'acme/greeter': [
    { version: '1.0.0', require: { php: '>=8.0', 'acme/util': '^1.0' }, autoload: { 'psr-4': { 'Acme\\Greeter\\': 'src/' } }, files: { 'src/Greeter.php': '<?php\nnamespace Acme\\Greeter;\nclass Greeter { public function greet(string $n): string { return "old $n"; } }\n' } },
    { version: '1.2.0', require: { php: '>=8.0', 'acme/util': '^1.1' }, autoload: { 'psr-4': { 'Acme\\Greeter\\': 'src/' } }, files: { 'src/Greeter.php': '<?php\nnamespace Acme\\Greeter;\nclass Greeter { public function greet(string $n): string { return \\Acme\\Util\\Shout::it("hello $n"); } }\n' } },
    { version: '2.0.0-beta1', require: { php: '>=8.0' }, autoload: { 'psr-4': { 'Acme\\Greeter\\': 'src/' } }, files: { 'src/Greeter.php': '<?php\nnamespace Acme\\Greeter;\nclass Greeter {}\n' } },
  ],
  'acme/util': [
    { version: '1.0.0', autoload: { 'psr-4': { 'Acme\\Util\\': 'src/' } }, files: { 'src/Shout.php': '<?php\nnamespace Acme\\Util;\nclass Shout { public static function it(string $s): string { return $s; } }\n' } },
    {
      version: '1.1.0',
      autoload: { 'psr-4': { 'Acme\\Util\\': 'src/' }, files: ['src/helpers.php'], classmap: ['lib/'] },
      files: {
        'src/Shout.php': '<?php\nnamespace Acme\\Util;\nclass Shout { public static function it(string $s): string { return strtoupper($s) . "!"; } }\n',
        'src/helpers.php': '<?php\nfunction acme_util_version(): string { return "1.1"; }\n',
        'lib/Legacy_Thing.php': '<?php\nclass Legacy_Thing { const KIND = "classmap"; }\n',
      },
    },
  ],
  'acme/native': [{ version: '1.0.0', require: { 'ext-pgsql': '*' }, files: { 'src/x.php': '<?php' } }],
};

interface FakePackagist {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

async function startFakePackagist(): Promise<FakePackagist> {
  const requests: string[] = [];
  let base = '';
  const zips = new Map<string, Uint8Array>();
  for (const [name, versions] of Object.entries(FIXTURES)) {
    for (const fixture of versions) {
      const fs = new VirtualFileSystem();
      const top = `${name.replace('/', '-')}-${fixture.version}`;
      const files: Record<string, string> = { ...fixture.files, 'composer.json': JSON.stringify({ name, autoload: fixture.autoload }) };
      fs.writeTree(Object.fromEntries(Object.entries(files).map(([path, content]) => [`${top}/${path}`, content])));
      zips.set(`/dist/${top}.zip`, exportZip(fs));
    }
  }
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    requests.push(path);
    const meta = /^\/packages\/(.+)\.json$/.exec(path);
    const versions = meta && FIXTURES[meta[1]!];
    if (versions) {
      const entries = versions.map((fixture) => [fixture.version, { name: meta![1], version: fixture.version, require: fixture.require ?? {}, autoload: fixture.autoload ?? {}, type: 'library', dist: { type: 'zip', url: `${base}/dist/${meta![1]!.replace('/', '-')}-${fixture.version}.zip`, reference: `ref-${fixture.version}` } }]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ package: { name: meta[1], versions: Object.fromEntries(entries) } }));
      return;
    }
    const zip = zips.get(path);
    res.writeHead(zip ? 200 : 404, { 'content-type': zip ? 'application/zip' : 'text/plain' });
    res.end(zip ? Buffer.from(zip) : 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${base}/packages/{name}.json`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const SLOW = 180_000;
let packagist: FakePackagist;
beforeAll(async () => {
  packagist = await startFakePackagist();
});
afterAll(() => packagist.close());

const APP = `<?php
require __DIR__ . '/vendor/autoload.php';
echo (new Acme\\Greeter\\Greeter())->greet('php'), ' ', acme_util_version(), ' ', Legacy_Thing::KIND, ' ', Composer\\InstalledVersions::getPrettyVersion('acme/greeter'), "\\n";
`;

describe('composer (offline: a local Packagist)', () => {
  it('resolves, locks, installs into vendor/ and autoloads; a second install comes from the lock with nothing to fetch', { timeout: SLOW }, async () => {
    const { fs, processes } = phpHost({ 'composer.json': JSON.stringify({ name: 'demo/app', require: { 'acme/greeter': '^1.0' } }), 'app.php': APP }, {}, { php: { composer: { repositoryUrl: packagist.url } } });
    const install = processes.run('composer', ['install']);
    const output = await readAll(install.combinedOutput);
    expect(await install.wait(), output).toBe(0);
    expect(output).toContain('Installing acme/greeter (1.2.0)');
    expect(output).toContain('Installing acme/util (1.1.0)');
    expect(output).toContain('Writing lock file');
    const lock = JSON.parse(fs.readText('/composer.lock')!) as { packages: Array<{ name: string; version: string }>; 'content-hash': string };
    expect(lock.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(['acme/greeter@1.2.0', 'acme/util@1.1.0']);
    expect(lock['content-hash']).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readText('/vendor/acme/util/src/helpers.php')).toContain('acme_util_version');

    const run = processes.run('php', ['app.php']);
    expect(await readAll(run.combinedOutput)).toBe('HELLO PHP! 1.1 classmap 1.2.0\n');
    expect(await run.wait()).toBe(0);

    const zipsBefore = packagist.requests.filter((path) => path.startsWith('/dist/')).length;
    const again = processes.run('composer', ['install']);
    const second = await readAll(again.combinedOutput);
    expect(await again.wait()).toBe(0);
    expect(second).toContain('Installing dependencies from lock file');
    expect(second).toContain('Nothing to install, update or remove');
    expect(second).not.toContain('not up to date');
    expect(packagist.requests.filter((path) => path.startsWith('/dist/')).length).toBe(zipsBefore);
    processes.dispose();
  });

  it('declines a package that needs an extension the php-wasm image lacks, by name, leaving composer.json and the lock as they were', { timeout: SLOW }, async () => {
    const original = JSON.stringify({ require: {} });
    const { fs, processes } = phpHost({ 'composer.json': original }, {}, { php: { composer: { repositoryUrl: packagist.url } } });
    const proc = processes.run('composer', ['require', 'acme/native']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(2);
    expect(output).toContain('acme/native 1.0.0 is declined: acme/native requires ext-pgsql *');
    expect(output).toContain('Bfwc\\Pgsql\\PDO');
    expect(fs.exists('/vendor/acme/native')).toBe(false);
    expect(fs.readText('/composer.json')).toBe(original);
    expect(fs.exists('/composer.lock')).toBe(false);
    processes.dispose();
  });

  it('refuses invalid package names and unsupported repositories before fetching anything', { timeout: SLOW }, async () => {
    const before = packagist.requests.length;
    const { processes } = phpHost(
      { 'composer.json': JSON.stringify({ require: { 'acme/greeter': '^1.0' }, repositories: [{ type: 'path', url: '../lib' }] }), 'bad/composer.json': JSON.stringify({ require: { '../../evil': '*' } }) },
      {},
      { php: { composer: { repositoryUrl: packagist.url } } },
    );
    const repos = processes.run('composer', ['install']);
    expect(await readAll(repos.combinedOutput)).toContain('repositories of type path');
    expect(await repos.wait()).toBe(2);
    const bad = processes.run('composer', ['install', '-d', 'bad']);
    expect(await readAll(bad.combinedOutput)).toContain('Invalid package name "../../evil"');
    expect(await bad.wait()).toBe(2);
    expect(packagist.requests.length).toBe(before);
    processes.dispose();
  });

  it('update vendor/pkg moves only that package (and what it needs); dump-autoload regenerates from installed.json', { timeout: SLOW }, async () => {
    const lock = {
      packages: [
        { name: 'acme/greeter', version: '1.0.0', require: { php: '>=8.0', 'acme/util': '^1.0' }, autoload: { 'psr-4': { 'Acme\\Greeter\\': 'src/' } }, dist: { type: 'zip', url: `${packagist.url.replace('/packages/{name}.json', '')}/dist/acme-greeter-1.0.0.zip`, reference: 'ref-1.0.0' } },
        { name: 'acme/util', version: '1.0.0', autoload: { 'psr-4': { 'Acme\\Util\\': 'src/' } }, dist: { type: 'zip', url: `${packagist.url.replace('/packages/{name}.json', '')}/dist/acme-util-1.0.0.zip`, reference: 'ref-1.0.0' } },
      ],
      'packages-dev': [],
    };
    const { fs, processes } = phpHost({ 'composer.json': JSON.stringify({ require: { 'acme/greeter': '^1.0' } }), 'composer.lock': JSON.stringify(lock) }, {}, { php: { composer: { repositoryUrl: packagist.url } } });
    const update = processes.run('composer', ['update', 'acme/util']);
    const output = await readAll(update.combinedOutput);
    expect(await update.wait(), output).toBe(0);
    const locked = (JSON.parse(fs.readText('/composer.lock')!) as { packages: Array<{ name: string; version: string }> }).packages.map((pkg) => `${pkg.name}@${pkg.version}`);
    expect(locked).toEqual(['acme/greeter@1.0.0', 'acme/util@1.1.0']);
    const dump = processes.run('composer', ['dump-autoload']);
    expect(await dump.wait()).toBe(0);
    expect(fs.readText('/vendor/composer/installed.json')).toContain('"name": "acme/util"');
    expect(fs.exists('/vendor/autoload.php')).toBe(true);
    processes.dispose();
  });
});

/** Packagist and GitHub's API answer, with enough unauthenticated quota left for ~10 zipballs. */
async function online(): Promise<string | undefined> {
  try {
    const [packagistUp, rate] = await Promise.all([
      fetch('https://packagist.org/packages/slim/slim.json', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then((response) => response.ok),
      fetch('https://api.github.com/rate_limit', { signal: AbortSignal.timeout(5000) }).then((response) => response.json() as Promise<{ resources?: { core?: { remaining?: number } } }>),
    ]);
    if (!packagistUp) return 'Packagist is unreachable';
    if ((rate.resources?.core?.remaining ?? 0) < 20) return "GitHub's unauthenticated API quota is exhausted";
    return undefined;
  } catch (error) {
    return `offline (${error instanceof Error ? error.message : String(error)})`;
  }
}

const SLIM_APP = String.raw`<?php
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

$url = parse_url(getenv('DATABASE_URL'));
$pdo = new \Bfwc\Pgsql\PDO(sprintf('pgsql:host=%s;port=%d;dbname=postgres', $url['host'], $url['port']), urldecode($url['user'] ?? 'postgres'), isset($url['pass']) ? urldecode($url['pass']) : null, [\PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
$pdo->exec('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text NOT NULL)');

$app = AppFactory::create();
$app->addBodyParsingMiddleware();
$json = function (Response $response, $data, int $status = 200): Response {
    $response->getBody()->write(json_encode($data));
    return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
};
$app->get('/health', fn (Request $request, Response $response) => $json($response, ['ok' => true]));
$app->get('/notes', fn (Request $request, Response $response) => $json($response, $pdo->query('SELECT id, body FROM notes ORDER BY id')->fetchAll()));
$app->post('/notes', function (Request $request, Response $response) use ($pdo, $json) {
    $insert = $pdo->prepare('INSERT INTO notes (body) VALUES (:body) RETURNING id');
    $insert->execute(['body' => $request->getParsedBody()['body']]);
    return $json($response, ['id' => $insert->fetchColumn()], 201);
});
$app->put('/notes/{id}', function (Request $request, Response $response, array $args) use ($pdo, $json) {
    $update = $pdo->prepare('UPDATE notes SET body = ? WHERE id = ?');
    $update->execute([$request->getParsedBody()['body'], (int) $args['id']]);
    return $json($response, ['updated' => $update->rowCount()]);
});
$app->delete('/notes/{id}', function (Request $request, Response $response, array $args) use ($pdo, $json) {
    $delete = $pdo->prepare('DELETE FROM notes WHERE id = ?');
    $delete->execute([(int) $args['id']]);
    return $json($response, ['deleted' => $delete->rowCount()]);
});
$app->run();
`;

describe('composer + Slim 4 against PGlite (online)', () => {
  it('installs Slim from Packagist, then a Slim app does CRUD against the shared database', { timeout: 600_000 }, async (context) => {
    const offline = await online();
    if (offline) {
      console.info(`Skipped (network-dependent): ${offline}`);
      return context.skip();
    }
    const { processes, databases } = appHost(
      { 'api/composer.json': JSON.stringify({ require: { php: '>=8.1', 'slim/slim': '^4.12', 'slim/psr7': '^1.6' } }), 'api/public/index.php': SLIM_APP },
      phpWorkers(),
      createPhpProcessKind(),
    );
    const install = processes.run('composer', ['install', '--no-dev'], { cwd: '/api' });
    const installLog = await readAll(install.combinedOutput);
    expect(await install.wait(), installLog).toBe(0);
    expect(installLog).toContain('Installing slim/slim');

    const spec: ApplicationSpec = {
      projectId: `php-slim-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'api', type: 'application', runtime: 'php', root: '/api', command: 'php', args: ['-S', '0.0.0.0:8000', '-t', 'public', 'public/index.php'], port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const runtime = { run: processes.run.bind(processes), onServerListening: (l: never) => processes.servers.onListening(l), onPortChange: (l: never) => processes.servers.onPortChange(l), listProcesses: () => processes.list() };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPhpProvider(runtime, { probeIntervalMs: 50 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 120_000 });
    await app.start();
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await request(processes.ports, 8000, method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
      return { status: response.status, body: jsonOf(response.text) };
    };
    expect(await call('POST', '/notes', { body: 'first' })).toEqual({ status: 201, body: { id: 1 } });
    expect(await call('POST', '/notes', { body: 'second' })).toEqual({ status: 201, body: { id: 2 } });
    expect(await call('PUT', '/notes/1', { body: 'first, edited' })).toEqual({ status: 200, body: { updated: 1 } });
    expect(await call('DELETE', '/notes/2')).toEqual({ status: 200, body: { deleted: 1 } });
    expect(await call('GET', '/notes')).toEqual({ status: 200, body: [{ id: 1, body: 'first, edited' }] });
    await app.dispose();
    processes.dispose();
  });
});
