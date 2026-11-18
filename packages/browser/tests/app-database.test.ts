/**
 * An application with a database, end to end: a `pglite` database service and
 * a plain-http Node API that does CRUD through the unmodified `pg` client over
 * `DATABASE_URL`. Restarting the API keeps the rows; the database outlives it.
 */
import { describe, expect, it } from 'vitest';
import { createNodeProvider, createPgliteProvider, startApplicationRuntime, type ApplicationSpec, type DatabaseServiceHost, type NodeServiceHost } from '../src/app.js';
import type { PreviewRuntime } from '../src/host.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost, collect, fakeLocks, installedPackage } from './databaseHelpers.js';

// Compile-time: a preview runtime IS a database service host (`createPgliteProvider(runtime)`).
export const previewRuntimeHostsDatabases = (runtime: PreviewRuntime): DatabaseServiceHost => runtime;

function nodeHost(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    request: (port, request) => processes.request(port, { method: 'GET', headers: {}, body: null, url: request.url }),
    listProcesses: () => processes.list(),
  };
}

const API = `
  const http = require('http');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (error) => console.log('idle client lost: ' + error.message)); // a database reset closes idle connections
  const ready = pool.query('CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL)');
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  http.createServer(async (req, res) => {
    try {
      await ready;
      if (req.url === '/health') return json(res, 200, (await pool.query('SELECT 1 AS ok')).rows[0]);
      if (req.method === 'POST' && req.url === '/items') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const row = (await client.query('INSERT INTO items (name) VALUES ($1) RETURNING id, name', [JSON.parse(body).name])).rows[0];
          if (JSON.parse(body).fail) throw new Error('rolled back');
          await client.query('COMMIT');
          return json(res, 201, row);
        } catch (error) {
          await client.query('ROLLBACK');
          return json(res, 400, { error: error.message });
        } finally {
          client.release();
        }
      }
      const match = /^\\/items\\/(\\d+)$/.exec(req.url);
      if (req.method === 'PUT' && match) {
        let body = '';
        for await (const chunk of req) body += chunk;
        return json(res, 200, (await pool.query('UPDATE items SET name = $1 WHERE id = $2 RETURNING id, name', [JSON.parse(body).name, Number(match[1])])).rows[0]);
      }
      if (req.method === 'DELETE' && match) return json(res, 200, { deleted: (await pool.query('DELETE FROM items WHERE id = $1', [Number(match[1])])).rowCount });
      if (req.url === '/items') return json(res, 200, (await pool.query('SELECT id, name FROM items ORDER BY id')).rows);
      json(res, 404, {});
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  }).listen(Number(process.env.PORT), () => console.log('api on ' + process.env.PORT + ' with ' + process.env.DATABASE_URL));
`;

describe('application runtime with a pglite database', () => {
  it('serves CRUD with transactions from a Node API over pg, and keeps the rows across an API restart', async () => {
    const { processes, databases } = appHost({ ...installedPackage('pg', { root: 'api/node_modules' }), 'api/server.js': API });
    const spec: ApplicationSpec = {
      projectId: `app-db-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: true } },
        { id: 'api', type: 'application', runtime: 'node', root: '/api', command: 'node', args: ['server.js'], port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const app = startApplicationRuntime(spec, {
      providers: [createNodeProvider(nodeHost(processes), { probeIntervalMs: 50 }), createPgliteProvider(databases, { locks: fakeLocks() })],
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await processes.request(8000, { method, url, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)) });
      return { status: response?.status, body: JSON.parse(new TextDecoder().decode(response?.body)) as unknown };
    };
    try {
      await app.start();
      expect(app.getService('db')?.state).toBe('running');

      expect(await call('POST', '/items', { name: 'first' })).toEqual({ status: 201, body: { id: 1, name: 'first' } });
      expect(await call('POST', '/items', { name: 'second' })).toEqual({ status: 201, body: { id: 2, name: 'second' } });
      expect(await call('POST', '/items', { name: 'doomed', fail: true })).toEqual({ status: 400, body: { error: 'rolled back' } });
      expect(await call('PUT', '/items/2', { name: 'renamed' })).toEqual({ status: 200, body: { id: 2, name: 'renamed' } });
      expect(await call('DELETE', '/items/1')).toEqual({ status: 200, body: { deleted: 1 } });

      await app.restart('api');
      expect(app.getService('db')?.restarts).toBe(0);
      expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'renamed' }] });

      const snapshot = await app.database('db').export();
      await app.database('db').reset();
      await app.restart('api'); // its pool's connections were closed by the reset
      expect(await call('GET', '/items')).toEqual({ status: 200, body: [] });
      await app.database('db').import(snapshot);
      await app.restart('api');
      expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'renamed' }] });
      expect(() => app.database('api')).toThrow('Service "api" is not a database.');
    } finally {
      await app.dispose();
    }
    await expect(app.database('db').export()).rejects.toThrow('Database "db" is not running.');
    expect(processes.ports.has(5432)).toBe(false);
  }, 240_000);

  it('SIGKILL stops a database at once, even with a client holding a transaction open', async () => {
    const { processes, databases, fs } = appHost(installedPackage('pg'));
    const provider = createPgliteProvider(databases);
    const handle = await provider.start(
      { id: 'db', type: 'database', runtime: 'pglite', port: 5460, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
      { env: { BUILDERFORCE_PROJECT_ID: 'kill' }, signal: new AbortController().signal },
    );
    void handle.output.cancel();
    await handle.ready();
    fs.writeFile('/hold.js', `
      const { Client } = require('pg');
      const c = new Client('postgres://postgres@localhost:5460/postgres');
      c.on('error', () => console.log('database gone'));
      c.connect().then(() => c.query('BEGIN')).then(() => console.log('holding'));
    `);
    const holder = processes.run('node', ['hold.js']);
    const output = collect(holder.combinedOutput);
    await output.until('holding');
    handle.kill('SIGKILL');
    expect(await handle.wait()).toBe(137);
    expect(processes.ports.has(5460)).toBe(false);
    expect(await output.done).toBe('holding\ndatabase gone\n');
  }, 60_000);
});
