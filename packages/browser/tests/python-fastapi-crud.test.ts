/**
 * PRD 31 §W9 exit test: a FastAPI app (FastAPI, uvicorn and pg8000 from PyPI)
 * served by the application runtime as its `/api` service, doing CRUD and a
 * transaction that fails part-way and is rolled back, against the shared
 * PGlite database the runtime starts — over HTTP on the runtime's virtual
 * port, through Python's sockets dialling the Postgres gateway. Needs the
 * network (PyPI, the Pyodide CDN): skipped offline.
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, createPythonProcessKind, createPythonProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { mixedWorkers, online, request } from './python-helpers.js';

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

const MAIN = `
import os, urllib.parse
import pg8000.native
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
_con = None

def db():
    global _con
    if _con is None:
        url = urllib.parse.urlparse(os.environ["DATABASE_URL"])
        _con = pg8000.native.Connection(
            urllib.parse.unquote(url.username or "postgres"), host=url.hostname, port=url.port or 5432,
            database=url.path.lstrip("/") or "postgres", password=urllib.parse.unquote(url.password) if url.password else None)
    return _con

def sqlstate(error):
    detail = error.args[0] if error.args else {}
    return detail.get("C") if isinstance(detail, dict) else None

class NewItem(BaseModel):
    name: str
    qty: int = 0

class ItemUpdate(BaseModel):
    qty: int
    active: bool

@app.get("/health")
def health():
    return {"ok": db().run("SELECT 1")[0][0] == 1}

@app.post("/migrate")
def migrate():
    db().run("CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL UNIQUE, qty int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true)")
    return {"migrated": True}

@app.get("/items")
def list_items():
    rows = db().run("SELECT id, name, qty, active FROM items ORDER BY id")
    return [{"id": r[0], "name": r[1], "qty": r[2], "active": r[3]} for r in rows]

@app.post("/items", status_code=201)
def create_item(item: NewItem):
    return {"id": db().run("INSERT INTO items (name, qty) VALUES (:name, :qty) RETURNING id", name=item.name, qty=item.qty)[0][0]}

@app.patch("/items/{item_id}")
def update_item(item_id: int, update: ItemUpdate):
    con = db()
    con.run("UPDATE items SET qty = :qty, active = :active WHERE id = :id", qty=update.qty, active=update.active, id=item_id)
    return {"updated": con.row_count}

@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    con = db()
    con.run("DELETE FROM items WHERE id = :id", id=item_id)
    return {"deleted": con.row_count}

@app.post("/transfer")
def transfer():
    con = db()
    con.run("BEGIN")
    try:
        con.run("INSERT INTO items (name) VALUES ('in-transaction')")
        con.run("INSERT INTO items (name) VALUES ('in-transaction')")  # unique violation
        con.run("COMMIT")
        return {"committed": True}
    except pg8000.native.DatabaseError as error:
        con.run("ROLLBACK")
        return JSONResponse(status_code=409, content={"rolledBack": True, "sqlstate": sqlstate(error)})
`;

describe('FastAPI against the PGlite gateway (PRD 31 W9; skipped offline)', () => {
  it('does CRUD and a rolled-back transaction from FastAPI + pg8000 on the /api service', { timeout: 300_000 }, async (context) => {
    if (!(await online())) {
      console.info('python-fastapi-crud: skipped, PyPI or the Pyodide CDN is unreachable (FastAPI, uvicorn and pg8000 come from the network).');
      return context.skip();
    }
    const { processes, databases } = appHost({ 'api/requirements.txt': 'fastapi\nuvicorn\npg8000\n', 'api/main.py': MAIN }, mixedWorkers(), createPythonProcessKind());
    const spec: ApplicationSpec = {
      projectId: `py-fastapi-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'api', type: 'application', runtime: 'python', root: '/api', command: 'uvicorn', args: ['main:app', '--port', '8000'], port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPythonProvider(runtimeOf(processes), { probeIntervalMs: 100 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 240_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('api')) logs.push(entry.text);
    })();
    const ports = processes.ports;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await request(ports, 8000, method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
      return { status: response.status, body: response.text ? (JSON.parse(response.text) as unknown) : null };
    };

    try {
      await app.start();
      expect(await call('POST', '/migrate')).toEqual({ status: 200, body: { migrated: true } });
      expect(await call('POST', '/items', { name: 'widget', qty: 3 })).toEqual({ status: 201, body: { id: 1 } });
      expect(await call('POST', '/items', { name: 'gadget' })).toEqual({ status: 201, body: { id: 2 } });
      expect(await call('PATCH', '/items/2', { qty: 7, active: false })).toEqual({ status: 200, body: { updated: 1 } });
      expect(await call('POST', '/transfer')).toEqual({ status: 409, body: { rolledBack: true, sqlstate: '23505' } });
      expect(await call('DELETE', '/items/1')).toEqual({ status: 200, body: { deleted: 1 } });
      // Exactly the surviving row: nothing from inside the rolled-back transaction.
      expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'gadget', qty: 7, active: false }] });
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    } finally {
      await app.dispose();
      processes.dispose();
    }
  });
});
