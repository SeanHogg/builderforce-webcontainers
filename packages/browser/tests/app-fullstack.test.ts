/**
 * A multi-service, multi-runtime application end to end through
 * `startApplicationRuntime` (ROADMAP item 24): the shape of an Angular/React +
 * Laravel + Postgres starter.
 *
 * - `db`: PGlite Postgres (`query` readiness);
 * - `setup`: `composer install` in `/api` — a one-off (exit-zero) that really
 *   resolves, downloads and autoloads packages (from a local stand-in for
 *   Packagist: offline): `demo/http`, and a stub `laravel/framework` holding
 *   only Laravel's `server.php` router, as Laravel ships it;
 * - `migrate`: `php artisan migrate` — a Laravel-style console (the project's
 *   own `artisan`, on the vendor autoloader) creating and seeding a table
 *   through `DATABASE_URL`;
 * - `api`: plain `php artisan serve` (Laravel's default 127.0.0.1:8000) —
 *   served by the PHP runtime as Laravel's ServeCommand would (`php -S` on
 *   `public/` through that `server.php`), since php-wasm has no `proc_open` to
 *   start it; http readiness on `/health`;
 * - `web`: a React app on Vite (`npm run dev` → the dev-server handoff of
 *   `/web`), ingress `/api` → api and `/` → web.
 *
 * Asserted: the services become ready in dependency order; Laravel's router
 * serves a static file from `public/` and hands everything else (a path with
 * an extension too) to the front controller; through the preview path (the
 * shared origin's attach, as the service worker routes it) the frontend
 * document `/` is the React app's page, served by the dev server compiled from
 * `/web`, and its relative `fetch('/api/items')` reaches the PHP API through
 * the live handoff's grant, which answers with the row it reads from PGlite.
 * The page's JavaScript is not executed (no browser): the fetch it makes is
 * issued as the service worker would route it.
 *
 * Real Laravel is not installed (its ~30 packages come from GitHub zipballs,
 * which needs the network and an API quota); the PHP runtime path it takes —
 * composer, artisan console, artisan serve with Laravel's router, PDO to the
 * gateway — is the same.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { DevServer, PortCookieJars, createEsbuildTransformer } from '@seanhogg/builderforce-webcontainers-core';
import type { StateChange } from '@seanhogg/builderforce-webcontainers-core/app';
import { createNodeProvider, createPgliteProvider, startApplicationRuntime, type ApplicationHost, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { attachPreview } from '../src/previewAttach.js';
import { createPreviewIngress } from '../src/previewIngress.js';
import { createSwIngressTable } from '../src/swIngressTable.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { startFakePackagist, type FakePackagist } from './fakePackagist.js';
import { jsonOf, phpWorkers, request, until } from './php-helpers.js';
import { recordingTransport, streamed, workerEnd } from './previewHarness.js';

/** The API's one dependency, served by the local Packagist. */
const PACKAGES = {
  'demo/http': [
    {
      version: '1.0.0',
      require: { php: '>=8.1' },
      autoload: { 'psr-4': { 'Demo\\Http\\': 'src/' } },
      files: {
        'src/Json.php': String.raw`<?php
namespace Demo\Http;
final class Json {
    public static function reply(int $status, $body): void {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($body);
    }
}
`,
      },
    },
  ],
  // Only what `php artisan serve` uses of the framework: its router, as Laravel ships it (minus the request log line).
  'laravel/framework': [
    {
      version: '11.0.0',
      require: { php: '>=8.1' },
      files: {
        'src/Illuminate/Foundation/resources/server.php': String.raw`<?php
$publicPath = getcwd();
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');
// This file allows us to emulate Apache's "mod_rewrite" functionality from the built-in PHP web server.
if ($uri !== '/' && file_exists($publicPath.$uri)) {
    return false;
}
require_once $publicPath.'/index.php';
`,
      },
    },
  ],
};

const FILES: Record<string, string> = {
  // The Laravel-style API in /api.
  'api/composer.json': JSON.stringify({ name: 'demo/api', require: { php: '>=8.1', 'demo/http': '^1.0', 'laravel/framework': '^11.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  'api/public/robots.txt': 'User-agent: *\nDisallow:\n',
  'api/artisan': String.raw`#!/usr/bin/env php
<?php
require __DIR__ . '/vendor/autoload.php';
$command = $argv[1] ?? 'list';
if ($command === 'migrate') {
    $pdo = App\Database::connect();
    $pdo->exec('CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL)');
    $pdo->exec("INSERT INTO items (name) SELECT 'from pglite' WHERE NOT EXISTS (SELECT 1 FROM items)");
    echo "Migrating: create_items_table\n";
    echo "Migrated:  create_items_table";
    exit(0);
}
fwrite(STDERR, "Command \"$command\" is not defined.\n");
exit(1);
`,
  'api/app/Database.php': String.raw`<?php
namespace App;
final class Database {
    public static function connect(): \PDO {
        $url = parse_url(getenv('DATABASE_URL'));
        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'], $url['port'] ?? 5432, ltrim($url['path'] ?? '/postgres', '/'));
        return new \Bfwc\Pgsql\PDO($dsn, urldecode($url['user'] ?? 'postgres'), isset($url['pass']) ? urldecode($url['pass']) : null, [\PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
    }
}
`,
  'api/app/ItemsController.php': String.raw`<?php
namespace App;
final class ItemsController {
    public function index(): array {
        return Database::connect()->query('SELECT id, name FROM items ORDER BY id')->fetchAll();
    }
}
`,
  'api/public/index.php': String.raw`<?php
require __DIR__ . '/../vendor/autoload.php';
use Demo\Http\Json;
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/health') {
    Json::reply(200, ['ok' => true]);
} elseif ($path === '/api/items' || $path === '/api/items.json') {
    Json::reply(200, (new App\ItemsController())->index());
} else {
    Json::reply(404, ['error' => "no route for $path"]);
}
`,
  // The React app on Vite in /web.
  'web/package.json': JSON.stringify({ name: 'web', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' } }),
  'web/index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  'web/src/main.jsx': [
    "import { createRoot } from 'react-dom/client';",
    "import { useEffect, useState } from 'react';",
    'function App() {',
    '  const [items, setItems] = useState([]);',
    "  useEffect(() => { fetch('/api/items').then((r) => r.json()).then(setItems); }, []);",
    '  return <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>;',
    '}',
    "createRoot(document.getElementById('root')).render(<App />);",
  ].join('\n'),
};

const SPEC: ApplicationSpec = {
  projectId: 'fullstack',
  services: [
    { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
    { id: 'setup', type: 'application', runtime: 'php', root: '/api', command: 'composer', args: ['install'] },
    { id: 'migrate', type: 'application', runtime: 'php', root: '/api', command: 'php', args: ['artisan', 'migrate'], dependsOn: ['setup', 'db'] },
    { id: 'api', type: 'application', runtime: 'php', root: '/api', command: 'php', args: ['artisan', 'serve'], port: 8000, dependsOn: ['migrate', 'db'], readiness: { kind: 'http', path: '/health' } },
    { id: 'web', type: 'application', runtime: 'node', role: 'frontend', root: '/web', command: 'npm', args: ['run', 'dev'], port: 5173, dependsOn: ['api'] },
  ],
  ingress: { routes: [{ path: '/api', serviceId: 'api' }, { path: '/', serviceId: 'web' }] },
};

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

/** The test realm's own `process`, before any in-thread Node process ran in it (they leave theirs on the global). */
const hostProcess = globalThis.process;

/**
 * esbuild for the dev server, run against the test realm's `process`: an in-thread Node process may have left
 * its own (virtual: `platform` linux, no real child processes) on the shared global, which esbuild reads as
 * it starts its service. In a browser the dev server runs on esbuild-wasm on the page, where no process runs.
 */
const hostEsbuild: Parameters<typeof createEsbuildTransformer>[0] = {
  transform(code, options) {
    const current = globalThis.process;
    globalThis.process = hostProcess;
    try {
      return esbuild.transform(code, options);
    } finally {
      globalThis.process = current;
    }
  },
};

let packagist: FakePackagist;
beforeAll(async () => {
  packagist = await startFakePackagist(PACKAGES);
  await esbuild.transform('export {}'); // esbuild's service started before any in-thread Node process runs
});
afterAll(() => packagist.close());

describe('React on Vite + a Laravel-style PHP API + PGlite, through startApplicationRuntime (offline)', () => {
  it('starts in dependency order, and the frontend’s /api ingress reaches the PHP API, which answers from PGlite', { timeout: 300_000 }, async () => {
    const { fs, processes, databases } = appHost(FILES, phpWorkers(), createPhpProcessKind({ composer: { repositoryUrl: packagist.url } }));

    // The host's wiring, as `startPreviewRuntime` does it: the shared origin's ingress follows the live handoff's application.
    const ingress = createPreviewIngress({
      ownerOf: (port) => processes.ports.ownerOf(port),
      handoffApplication: () => {
        const live = processes.handoffs.current();
        return live ? ingress.handoffApplication(live.context, live.root ?? '/') : undefined;
      },
    });
    // The shared origin's dev server serves the live handoff's directory.
    const server = new DevServer({ fs, transformer: createEsbuildTransformer(hostEsbuild), base: '/__bfwc/p1/', attribution: false });
    const stopHandoffs = processes.handoffs.onChange(() => {
      server.setRoot(processes.handoffs.current()?.root ?? '/');
      ingress.refresh();
    });
    const runtime: ApplicationHost = {
      portPolicy: processes.portPolicy,
      killApplication: (applicationId, serviceId) => processes.killApplication(applicationId, serviceId),
      registerIngress: (applicationId, spec) => ingress.register(applicationId, spec),
    };
    const host = runtimeOf(processes);
    const app = startApplicationRuntime(SPEC, {
      runtime,
      providers: [createPgliteProvider(databases, { locks: fakeLocks() }), createPhpProvider(host, { probeIntervalMs: 50 }), createNodeProvider(host)],
      readinessTimeoutMs: 120_000,
    });

    const ready: string[] = [];
    const changes: StateChange[] = [];
    app.onStateChange((change) => {
      changes.push(change);
      if (change.to === 'ready') ready.push(change.serviceId);
    });
    const errors: string[] = [];
    app.onError((error) => errors.push(`${error.serviceId} ${error.phase}: ${error.message}`));
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs()) logs.push(`${entry.serviceId}| ${entry.text}`);
    })();

    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${errors.join('\n')}\n${logs.join('\n')}`);
    }
    expect(errors).toEqual([]);

    // Dependency order: each service is ready only after everything it depends on.
    const at = (id: string) => ready.indexOf(id);
    expect(new Set(ready)).toEqual(new Set(['db', 'setup', 'migrate', 'api', 'web']));
    expect(at('setup')).toBeLessThan(at('migrate'));
    expect(at('db')).toBeLessThan(at('migrate'));
    expect(at('migrate')).toBeLessThan(at('api'));
    expect(at('api')).toBeLessThan(at('web'));
    // The one-offs finished (stopped, not failed); the servers run.
    expect(app.listServices().map(({ id, state }) => [id, state])).toEqual([
      ['db', 'running'],
      ['setup', 'stopped'],
      ['migrate', 'stopped'],
      ['api', 'running'],
      ['web', 'running'],
    ]);
    expect(changes.some((change) => change.to === 'failed')).toBe(false);
    // composer install really installed: the package and the autoloader are in vendor/.
    expect(fs.isFile('/api/vendor/demo/http/src/Json.php')).toBe(true);
    expect(fs.isFile('/api/vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php')).toBe(true);
    // Plain `php artisan serve`: Laravel's default address, through Laravel's router.
    expect(logs.some((line) => line.startsWith('api| ') && line.includes('(http://127.0.0.1:8000) started'))).toBe(true);
    const direct = async (url: string) => {
      const response = await request(processes.ports, 8000, 'GET', url);
      return { status: response.status, text: response.text, type: response.headers['content-type'] };
    };
    expect(await direct('/robots.txt')).toMatchObject({ status: 200, text: 'User-agent: *\nDisallow:\n', type: expect.stringContaining('text/plain') }); // a file under public/: served as is
    expect(await direct('/api/items.json')).toMatchObject({ status: 200, text: '[{"id":1,"name":"from pglite"}]' }); // no such file: the front controller
    expect(await direct('/nowhere.css')).toMatchObject({ status: 404, text: '{"error":"no route for \\/nowhere.css"}' }); // the router's 404 is the app's, not the built-in server's
    expect(logs).toContain('migrate| Migrated:  create_items_table'); // the one-off's unterminated last line
    // The frontend is the dev-server handoff of /web, attributed to the web service.
    expect(app.getUrl('web')).toBe('https://app.test/__bfwc/p1/');
    expect(processes.handoffs.current()).toMatchObject({ port: 5173, root: '/web', context: { applicationId: app.applicationId, serviceId: 'web' } });

    // The preview: the shared origin (it admits no application port by itself), its dev-server document is the frontend.
    const { transport, ports } = recordingTransport();
    const stopAttach = attachPreview({ transport, id: 'p1', server, processes, cookies: new PortCookieJars(), scripts: () => [], bridgeNonce: 'b', mayServePort: () => false, ingress: ingress.view(undefined) });
    const worker = workerEnd(ports[0]!);
    await until(() => worker.tables.length > 0); // the attach carries the table
    expect(worker.tables.at(-1)).toEqual({ type: 'ingress', routes: [{ path: '/api', port: 8000 }, { path: '/', port: 5173 }] });

    // The service worker routes by that table: the document `/` is the dev server's…
    const sw = createSwIngressTable({ waitMs: 0, requestAttach: () => undefined });
    sw.set('p1', worker.tables.at(-1)!.routes);
    const page = sw.route('p1', new URL('https://app.preview.test/'), undefined)!;
    expect(page).toEqual({ id: 'p1', path: '/', search: '' });
    const documentResponse = await worker.ask(page.path, page.from, page.search);
    const html = await streamed(ports[0]!, documentResponse);
    expect(documentResponse.status, html).toBe(200);
    expect(html).toContain('<div id="root"></div>'); // /web/index.html: the React app's page, not the project's
    const entry = await worker.ask('/src/main.jsx');
    const script = await streamed(ports[0]!, entry);
    expect(entry.status, script).toBe(200);
    expect(script).toMatch(/fetch\(["']\/api\/items["']\)/); // compiled from /web/src/main.jsx (JSX gone)
    expect(script).not.toContain('<App />');
    // …and its relative fetch goes to the API's port.
    const target = sw.route('p1', new URL('https://app.preview.test/api/items'), undefined)!;
    expect(target).toEqual({ id: 'p1', path: '/__port/8000/api/items', search: '', from: { ingress: true } });
    // …and the host answers it from the PHP API, which read the row from PGlite.
    const response = await worker.ask(target.path, target.from, target.search);
    const body = await streamed(ports[0]!, response);
    expect(response.status, body).toBe(200);
    expect(jsonOf(body)).toEqual([{ id: 1, name: 'from pglite' }]);

    stopAttach();
    stopHandoffs();
    await app.dispose();
    processes.dispose();
  });
});
