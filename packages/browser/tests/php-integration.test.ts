/**
 * The PHP runtime inside the whole runtime: a `php -S` API — a plain front
 * controller using the runtime's PDO (`Bfwc\Pgsql\PDO`, a `\PDO`) — doing CRUD,
 * prepared statements with `?` and `:name` placeholders, typed results and a
 * rolled-back transaction against the PGlite database the application runtime
 * starts, through PHP's sockets dialling the Postgres gateway's virtual port.
 * Offline: nothing comes from the network.
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { jsonOf, phpWorkers, request } from './php-helpers.js';

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

const API = String.raw`<?php
// A Slim-style front controller on PDO. Typed as \PDO: the runtime's PDO is one.
function db(): \PDO {
    static $pdo;
    if (!$pdo) {
        $url = parse_url(getenv('DATABASE_URL'));
        $pdo = new \Bfwc\Pgsql\PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'], $url['port'] ?? 5432, ltrim($url['path'] ?? '/postgres', '/')), $url['user'] ?? 'postgres', $url['pass'] ?? null, [\PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
    }
    return $pdo;
}
function reply(int $status, $body): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
}
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
try {
    if ($path === '/health') {
        reply(200, ['ok' => db()->query('SELECT 1 AS one')->fetchColumn() === 1]);
    } elseif ($path === '/migrate' && $method === 'POST') {
        db()->exec('CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL UNIQUE, qty int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, price double precision); CREATE INDEX IF NOT EXISTS items_name ON items (name);');
        reply(200, ['migrated' => true]);
    } elseif ($path === '/items' && $method === 'GET') {
        reply(200, db()->query('SELECT id, name, qty, active, price FROM items ORDER BY id')->fetchAll());
    } elseif ($path === '/items' && $method === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);
        $insert = db()->prepare('INSERT INTO items (name, qty, price) VALUES (:name, :qty, :price) RETURNING id');
        $insert->execute(['name' => $input['name'], 'qty' => $input['qty'] ?? 0, 'price' => $input['price'] ?? null]);
        reply(201, ['id' => $insert->fetchColumn(), 'lastInsertId' => db()->lastInsertId()]);
    } elseif (preg_match('#^/items/(\d+)$#', $path, $m) && $method === 'PATCH') {
        $input = json_decode(file_get_contents('php://input'), true);
        $update = db()->prepare('UPDATE items SET qty = ?, active = ? WHERE id = ?');
        $update->bindValue(1, $input['qty'], \PDO::PARAM_INT);
        $update->bindValue(2, $input['active'], \PDO::PARAM_BOOL);
        $update->bindValue(3, (int) $m[1], \PDO::PARAM_INT);
        $update->execute();
        reply(200, ['updated' => $update->rowCount()]);
    } elseif (preg_match('#^/items/(\d+)$#', $path, $m) && $method === 'DELETE') {
        $delete = db()->prepare('DELETE FROM items WHERE id = ?');
        $delete->execute([(int) $m[1]]);
        reply(200, ['deleted' => $delete->rowCount()]);
    } elseif ($path === '/transfer' && $method === 'POST') {
        // A transaction that fails part-way rolls back.
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $pdo->exec("INSERT INTO items (name) VALUES ('in-transaction')");
            $pdo->exec("INSERT INTO items (name) VALUES ('in-transaction')"); // unique violation
            $pdo->commit();
            reply(200, ['committed' => true]);
        } catch (\PDOException $e) {
            $pdo->rollBack();
            reply(409, ['rolledBack' => true, 'sqlstate' => $e->getCode(), 'inTransaction' => $pdo->inTransaction()]);
        }
    } else {
        reply(404, ['error' => "no route for $method $path"]);
    }
} catch (\PDOException $e) {
    reply(500, ['error' => $e->getMessage(), 'sqlstate' => $e->getCode()]);
}
`;

describe('PHP API against the PGlite gateway (offline)', () => {
  it('does CRUD, typed results and a rolled-back transaction through the runtime PDO, and keeps its data across an API restart', { timeout: 300_000 }, async () => {
    const { processes, databases } = appHost({ 'api/public/index.php': API }, phpWorkers(), createPhpProcessKind());
    const spec: ApplicationSpec = {
      projectId: `php-db-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'api', type: 'application', runtime: 'php', root: '/api', command: 'php', args: ['-S', '0.0.0.0:8000', '-t', 'public', 'public/index.php'], port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const app = startApplicationRuntime(spec, { providers: [createPhpProvider(runtimeOf(processes), { probeIntervalMs: 50 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 120_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('api')) logs.push(entry.text);
    })();
    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    }
    const ports = processes.ports;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await request(ports, 8000, method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
      return { status: response.status, body: jsonOf(response.text) };
    };

    expect(await call('POST', '/migrate')).toEqual({ status: 200, body: { migrated: true } });
    expect(await call('POST', '/items', { name: 'widget', qty: 3, price: 9.5 })).toEqual({ status: 201, body: { id: 1, lastInsertId: '1' } });
    expect(await call('POST', '/items', { name: 'gadget' })).toEqual({ status: 201, body: { id: 2, lastInsertId: '2' } });
    expect(await call('PATCH', '/items/2', { qty: 7, active: false })).toEqual({ status: 200, body: { updated: 1 } });
    const transfer = await call('POST', '/transfer');
    expect(transfer).toEqual({ status: 409, body: { rolledBack: true, sqlstate: '23505', inTransaction: false } });
    const duplicate = await call('POST', '/items', { name: 'widget' });
    expect(duplicate.status).toBe(500);
    expect(duplicate.body).toMatchObject({ sqlstate: '23505', error: expect.stringContaining('SQLSTATE[23505]') });
    expect(await call('DELETE', '/items/1')).toEqual({ status: 200, body: { deleted: 1 } });
    expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'gadget', qty: 7, active: false, price: null }] });

    // The API restarts; the database (and its rows) does not.
    await app.restart('api');
    expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'gadget', qty: 7, active: false, price: null }] });
    expect(await call('POST', '/items', { name: 'after restart', qty: 1, price: 2.25 })).toMatchObject({ status: 201 });
    const items = (await call('GET', '/items')).body as Array<{ name: string; price: number | null }>;
    expect(items.map((item) => item.name)).toEqual(['gadget', 'after restart']);
    expect(items[1]!.price).toBe(2.25);
    expect(logs.join('')).toContain('Development Server');

    await app.dispose();
    processes.dispose();
  });
});
