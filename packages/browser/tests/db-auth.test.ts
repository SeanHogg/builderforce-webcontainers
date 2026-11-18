/**
 * W10 controls 4 and 5 end to end: the pglite provider's gateway authenticates
 * every connection with logins the runtime generates per client service, owns
 * one database name, and admits only the service a login was issued to — as
 * the page-side identity of the dialling process says, never what the process
 * claims. Unmodified `pg` in process Workers is the client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceGraphPolicy, type ApplicationSpec, type DatabaseCredential, type ServiceHandle, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { createPgliteProvider } from '../src/app/pgliteProvider.js';
import { appHost, collect, installedPackage } from './databaseHelpers.js';

const PORT = 5470;
const spec: ApplicationSpec = {
  projectId: 'db-auth',
  services: [
    { id: 'db', type: 'database', runtime: 'pglite', port: PORT, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false, password: 'static-spec-password' } },
    { id: 'api', type: 'application', runtime: 'node', command: 'node', dependsOn: ['db'] },
    { id: 'web', type: 'application', runtime: 'node', command: 'node', role: 'frontend', dependsOn: ['db'] },
  ],
};
const db = spec.services[0]!;
const service = (id: string): ServiceSpec => spec.services.find((candidate) => candidate.id === id)!;
const as = (applicationId: string, serviceId: string): SecurityContext => ({ applicationId, serviceId });

/** Connect with `url` as `identity`; prints `ok <n>` or the error's code. */
const CLIENT = `
  const { Client } = require('pg');
  const c = new Client(process.env.URL);
  c.on('error', () => {});
  c.connect().then(() => c.query('SELECT 40 + 2 AS n')).then((r) => { console.log('ok ' + r.rows[0].n); return c.end(); }, (e) => console.log('error ' + (e.code || e.message)));
`;

describe('authenticated database (W10 control 5)', () => {
  const runtime = appHost({ ...installedPackage('pg'), 'client.js': CLIENT });
  const provider = createPgliteProvider(runtime.databases);
  let handle: ServiceHandle;
  let api: DatabaseCredential;
  const url = (login: DatabaseCredential, database = 'postgres') => `postgres://${login.user}:${login.password}@localhost:${PORT}/${database}`;

  async function connect(identity: SecurityContext, connectionString: string): Promise<string> {
    const proc = runtime.processes.run('node', ['client.js'], { env: { URL: connectionString }, identity });
    const output = await collect(proc.combinedOutput).done;
    await proc.wait();
    return output.trim();
  }

  beforeAll(async () => {
    (runtime.processes.ports.policy as ServiceGraphPolicy).register('a', spec);
    (runtime.processes.ports.policy as ServiceGraphPolicy).register('b', spec);
    api = provider.databaseCredentials!(db, service('api'))!;
    handle = await provider.start(db, { env: { BUILDERFORCE_PROJECT_ID: spec.projectId }, signal: new AbortController().signal, security: as('a', 'db') });
    void handle.output.cancel();
    await handle.ready();
  }, 60_000);
  afterAll(async () => {
    handle.kill();
    await handle.wait();
  });

  it('generates a login per backend, never the static spec password, and none for a frontend', () => {
    expect(api.password).not.toBe('static-spec-password');
    expect(api.password).toMatch(/^[0-9a-f]{48}$/);
    expect(provider.databaseCredentials!(db, service('api'))).toEqual(api); // stable for the runtime
    expect(provider.databaseCredentials!(db, service('web'))).toBeUndefined();
  });

  it('serves an unmodified pg client that connects with its generated login, along the declared edge', async () => {
    expect(await connect(as('a', 'api'), url(api))).toBe('ok 42');
  }, 60_000);

  it('refuses a wrong password (28P01) and the static spec password', async () => {
    expect(await connect(as('a', 'api'), url({ user: api.user, password: 'guess' }))).toBe('error 28P01');
    expect(await connect(as('a', 'api'), url({ user: 'postgres', password: 'static-spec-password' }))).toBe('error 28P01');
  }, 60_000);

  it('refuses a database name the application does not own (3D000)', async () => {
    expect(await connect(as('a', 'api'), url(api, 'other'))).toBe('error 3D000');
  }, 60_000);

  it('refuses a frontend even holding a backend login (28000): the page-side caller decides, not the login', async () => {
    expect(await connect(as('a', 'web'), url(api))).toBe('error 28000');
  }, 60_000);

  it("refuses another application's service at the port (ECONNREFUSED), whatever login it holds", async () => {
    expect(await connect(as('b', 'api'), url(api))).toBe('error ECONNREFUSED');
  }, 60_000);

  it('refuses a raw page-side connection with no login before any password exchange', async () => {
    const socket = runtime.processes.ports.connect(PORT, as('a', 'web'))!;
    const received: number[] = [];
    socket.onData((data) => received.push(...data));
    const closed = new Promise<void>((resolve) => socket.onClose(resolve));
    const params = new TextEncoder().encode('user\0web\0database\0postgres\0\0');
    const startup = new Uint8Array(8 + params.length);
    new DataView(startup.buffer).setInt32(0, startup.length);
    new DataView(startup.buffer).setInt32(4, 196608);
    startup.set(params, 8);
    socket.send(startup);
    await closed;
    const text = new TextDecoder().decode(Uint8Array.from(received));
    expect(String.fromCharCode(received[0]!)).toBe('E'); // no AuthenticationCleartextPassword first
    expect(text).toContain('28000');
  });
});
