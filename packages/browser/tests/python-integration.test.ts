/**
 * The Python runtime inside the whole runtime: host extensions (the shape of
 * the @webdit/torch bridge) installed before a program, and — offline, from
 * vendored wheels — an unmodified pg8000 doing CRUD and a rolled-back transaction
 * against the PGlite database the application runtime starts, through Python's
 * sockets dialling the Postgres gateway's virtual port.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, createPythonProcessKind, createPythonProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { downloadedPackages, mixedWorkers, pythonHost, readAll } from './python-helpers.js';
import { FIXTURES, startFakeIndex } from './python-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TINY_TORCH = { moduleUrl: pathToFileURL(join(here, 'fixtures', 'tiny-torch-extension.mjs')).href, exportName: 'createTinyTorch' };

describe('host Python extensions', () => {
  it('install a JS module and a Python package before the program, and satisfy their requirement', { timeout: 120_000 }, async () => {
    const { python } = pythonHost(
      {
        'requirements.txt': 'torch==2.3.0\n',
        'main.py': 'import torch, _tiny_engine\nprint(torch.__version__, torch.add(2, 3), _tiny_engine.calls())\n',
      },
      {},
      { python: { extensions: [TINY_TORCH] } },
    );
    const proc = python.run('python', ['main.py']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(0);
    expect(output).toContain('0.0-tiny 5 1\n');
    expect(output).not.toContain('Declined');
    const pip = python.run('pip', ['install', 'torch']);
    expect(await readAll(pip.combinedOutput)).toContain('Provided by the runtime (not installed): torch');
    expect(await pip.wait()).toBe(0);
    python.dispose();
  });
});

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

const CRUD = `
import json, os, urllib.parse
import pg8000.native

url = urllib.parse.urlparse(os.environ["DATABASE_URL"])
con = pg8000.native.Connection(url.username or "postgres", host=url.hostname, port=url.port or 5432, database=url.path.lstrip("/") or "postgres", password=url.password)
con.run("CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL)")
con.run("INSERT INTO items (name) VALUES (:name)", name="one")
con.run("UPDATE items SET name = :name WHERE id = 1", name="uno")
con.run("START TRANSACTION")
con.run("INSERT INTO items (name) VALUES ('rolled back')")
con.run("ROLLBACK")
con.run("INSERT INTO items (name) VALUES ('two')")
deleted = con.run("DELETE FROM items WHERE name = 'two' RETURNING id")
rows = con.run("SELECT id, name FROM items ORDER BY id")
con.close()
open("result.json", "w").write(json.dumps({"rows": rows, "deleted": len(deleted)}))
`;

describe('pg8000 against the PGlite gateway (offline: vendored wheels)', () => {
  it('does CRUD and a rolled-back transaction from an unmodified pg8000', { timeout: 300_000 }, async () => {
    const index = await startFakeIndex(FIXTURES);
    const { fs, processes, databases } = appHost({ 'job/requirements.txt': 'pg8000==1.31.6\n', 'job/crud.py': CRUD }, mixedWorkers(), createPythonProcessKind());
    const spec: ApplicationSpec = {
      projectId: `py-db-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'job', type: 'application', runtime: 'python', root: '/job', command: 'python', args: ['crud.py'], dependsOn: ['db'], readiness: { kind: 'exit-zero' }, restartPolicy: 'never', env: { PIP_INDEX_URL: index.url } },
      ],
    };
    const app = startApplicationRuntime(spec, { providers: [createPythonProvider(runtimeOf(processes)), createPgliteProvider(databases, { locks: fakeLocks() })] });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('job')) logs.push(entry.text);
    })();
    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('\n')}`);
    }
    expect(JSON.parse(fs.readText('/job/result.json')!)).toEqual({ rows: [[1, 'uno']], deleted: 1 });
    // Nothing came from the network: pg8000, scramp, asn1crypto from the local index; micropip, python-dateutil, six from the seeded cache.
    expect(downloadedPackages()).toEqual([]);
    expect(index.requests).toContain('/simple/pg8000/');
    await app.dispose();
    processes.dispose();
    await index.close();
  });
});
