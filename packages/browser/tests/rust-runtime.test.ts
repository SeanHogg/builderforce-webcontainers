/**
 * The Rust runtime's exit criterion (PRD 31 §W9 phase 6d) on real prebuilt
 * modules: a WASI command runs to completion over the project's files, and an
 * axum service on tokio-postgres (rust-fixtures/todo-service, a bfwc-wasi
 * reactor) is served on a virtual port and does CRUD — with a rolled-back
 * transaction — against the PGlite database the application runtime starts,
 * dialling the Postgres gateway over virtual TCP.
 *
 * Skipped until the fixtures are built (scripts/build-rust-fixtures.mjs needs
 * rustup's wasm32-wasip1 target; or set BFWC_RUST_FIXTURES).
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { createRustProcessKind, createRustProvider } from '../src/runtimes/rust/index.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { readAll } from './helpers.js';
import { request } from './httpHelpers.js';
import { RUST_FIXTURES_DIR, fixture, rustHost, rustWorkers } from './rust-helpers.js';

const MODULE = 'target/wasm32-wasip1/release';

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

describe.skipIf(!RUST_FIXTURES_DIR)('Rust runtime on prebuilt wasm32-wasip1 modules (real fixtures)', () => {
  it('runs a WASI command: arguments, environment, files both ways, exit code', async () => {
    const { fs, processes } = rustHost({ [`work/${MODULE}/hello.wasm`]: fixture('hello.wasm'), 'work/input.txt': 'shout' }, { GREETING: 'hi' });
    const proc = processes.run(`./${MODULE}/hello.wasm`, ['a', 'b'], { cwd: '/work' });
    const [output, code] = await Promise.all([readAll(proc.combinedOutput), proc.wait()]);
    expect(output).toContain('hello from rust: a b');
    expect(output).toContain('GREETING=hi');
    expect(output).toContain('wrote output.txt');
    expect(code).toBe(2);
    expect(fs.readText('/work/output.txt')).toBe('SHOUT'); // the module's write reached the page
    processes.dispose();
  });

  it('wasmtime run gives only what its options give: --env, --env NAME inherited, --dir preopens', async () => {
    const { fs, processes } = rustHost({ 'hello.wasm': fixture('hello.wasm'), 'data/input.txt': 'quiet' }, { GREETING: 'inherited' });
    const bare = processes.run('wasmtime', ['run', 'hello.wasm']);
    const [bareOutput, bareCode] = await Promise.all([readAll(bare.combinedOutput), bare.wait()]);
    expect(bareOutput).not.toContain('GREETING='); // no --env: no environment
    expect(bareOutput).toContain('no input.txt'); // no --dir: no files
    expect(bareCode).toBe(0);
    const run = processes.run('wasmtime', ['run', '--env', 'GREETING', '--dir', 'data::.', 'hello.wasm', 'x']);
    const [output, code] = await Promise.all([readAll(run.combinedOutput), run.wait()]);
    expect(output).toContain('GREETING=inherited');
    expect(output).toContain('wrote output.txt');
    expect(fs.readText('/data/output.txt')).toBe('QUIET');
    expect(code).toBe(1);
    const set = processes.run('wasmtime', ['run', '--env', 'GREETING=env', 'hello.wasm']);
    expect(await readAll(set.combinedOutput)).toContain('GREETING=env');
    const cargo = processes.run('cargo', ['run']);
    const [declined, cargoCode] = await Promise.all([readAll(cargo.combinedOutput), cargo.wait()]);
    expect(declined).toMatch(/rustc gate has not passed/);
    expect(cargoCode).toBe(1);
    processes.dispose();
  });

  it('serves an axum service that does CRUD with tokio-postgres against the PGlite gateway', { timeout: 120_000 }, async () => {
    const { fs, processes, databases } = appHost({}, rustWorkers, createRustProcessKind());
    fs.writeFile(`/api/${MODULE}/todo_service.wasm`, fixture('todo_service.wasm'));
    const spec: ApplicationSpec = {
      projectId: `rust-db-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'api', type: 'application', runtime: 'rust', root: '/api', command: `./${MODULE}/todo_service.wasm`, port: 8080, env: { PORT: '8080' }, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const app = startApplicationRuntime(spec, { providers: [createRustProvider(runtimeOf(processes), { probeIntervalMs: 50, fs }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 60_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('api')) logs.push(entry.text);
    })();
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await request(processes.ports, 8080, method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
      return { status: response.status, body: response.text ? JSON.parse(response.text) : undefined };
    };
    try {
      const started = performance.now();
      await app.start();
      const ready = performance.now() - started;
      expect(await call('GET', '/health')).toEqual({ status: 200, body: { ok: true } });
      const timed = performance.now();
      expect(await call('POST', '/todos', { title: 'write rust' })).toEqual({ status: 201, body: { id: 1 } });
      const insertMs = performance.now() - timed;
      expect(await call('POST', '/todos', { title: 'ship it' })).toEqual({ status: 201, body: { id: 2 } });
      expect(await call('PATCH', '/todos/2', { done: true })).toEqual({ status: 200, body: { updated: 1 } });
      expect(await call('POST', '/transfer')).toEqual({ status: 409, body: { rolledBack: true, sqlstate: '23505' } });
      expect(await call('DELETE', '/todos/1')).toEqual({ status: 200, body: { deleted: 1 } });
      expect(await call('GET', '/todos')).toEqual({ status: 200, body: [{ id: 2, title: 'ship it', done: true }] });
      expect((await call('GET', '/missing')).status).toBe(404);
      expect(logs.join('')).toContain('listening on http://0.0.0.0:8080');
      expect(logs.join('')).toContain('connected to postgres on port 5432');
      console.log(`rust service: ready in ${ready.toFixed(0)}ms (boot + first connection + schema), insert round trip ${insertMs.toFixed(1)}ms`);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    } finally {
      await app.dispose();
      processes.dispose();
    }
  });
});
